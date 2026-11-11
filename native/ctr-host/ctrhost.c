// souldew's Nintendo 3DS host: runs Azahar's libretro core (azahar_libretro) with Vulkan (MoltenVK on macOS) and
// talks to souldew over stdin/stdout – the 3DS game then plays inside souldew's own player like every other system.
//
//   ctrhost --core <azahar_libretro> --vulkan <libMoltenVK / vulkan loader> --rom <game> --system <dir> --save <dir>
//           [--scale N] [--bench FRAMES --dump out.ppm]
//
// Messages are { u32 type, u32 length, payload } (little-endian), both ways.
//   host → souldew   1 HELLO  json { width, height, fps, sampleRate }      sent once the game runs
//                    2 VIDEO  u16 width, u16 height, u32 format (0 BGRA, 1 RGBA), pixels
//                    3 AUDIO  s16 stereo samples
//                    4 MEM    u32 count, count × { u32 addr, u32 len, bytes }  the watched regions, between frames
//                    5 STATE  a save state (answer to SAVE)
//                    6 LOG    text
//                    7 EVENT  json  { event: 'loaded' | 'error' | 'stateLoaded' | 'stats', … }
//   souldew → host   1 INPUT  u32 joypad bits (RETRO_DEVICE_ID_JOYPAD_*), s16 lx, ly, rx, ry, s16 px, py (pointer,
//                             -0x7fff…0x7fff over the whole picture), u8 pressed
//                    2 SPEED  f32 (1 = normal, 0 = paused, ≥ 100 = as fast as possible)
//                    3 SAVE   –           4 LOAD  state bytes      5 WATCH  u32 count, count × { u32 addr, u32 len }
//                    6 QUIT   –           7 RESET –                8 FRAMESKIP u32 (send every n-th picture in turbo)
// Memory reads go through souldew_read_memory (native/azahar-patch: the game process's virtual memory, page by page)
// between two frames – never torn. Azahar's own core (no patch) runs the game without live data.
// Builds on macOS, Linux and Windows (compat.h); scripts/build-ctr.mjs builds it.
#define VK_NO_PROTOTYPES
#include <vulkan/vulkan.h>
#include "libretro.h"
#include "libretro_vulkan.h"

#include <errno.h>
#include <math.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "compat.h" // dlopen, mutexes, the reader thread, stdin/stdout, time (POSIX or Windows)

#define EXP RETRO_ENVIRONMENT_EXPERIMENTAL
#define IS(cmd, k) (((cmd) & ~EXP) == ((k) & ~EXP))

static void die(const char *fmt, ...);
static void logf_(const char *fmt, ...);

// ---- options ---------------------------------------------------------------------------------------------------
static const char *opt_core, *opt_vulkan, *opt_rom, *opt_system, *opt_save, *opt_dump;
static int opt_bench = 0, opt_scale = 1;
static char scale_str[8] = "1";

// core options souldew sets (everything else: the core's own default)
static const char *core_option(const char *key) {
  if (!strcmp(key, "citra_graphics_api")) return "Vulkan";
  if (!strcmp(key, "citra_resolution_factor")) return scale_str;
  if (!strcmp(key, "citra_layout_option")) return "default"; // top above bottom
  if (!strcmp(key, "citra_use_libretro_save_path")) return "LibRetro Default";
  if (!strcmp(key, "citra_analog_function")) return "c_stick";
  if (!strcmp(key, "citra_enable_mouse_touchscreen")) return "disabled";
  if (!strcmp(key, "citra_enable_touch_touchscreen")) return "enabled";
  if (!strcmp(key, "citra_enable_touch_pointer_timeout")) return "enabled"; // the touch cursor fades after a few seconds
  if (!strcmp(key, "citra_use_disk_shader_cache")) return "enabled";
  if (!strcmp(key, "citra_is_new_3ds")) return getenv("CTRHOST_OLD3DS") ? "Old 3DS" : "New 3DS"; // as Azahar itself (the addresses the trackers know)
  return NULL;
}

// ---- protocol out ----------------------------------------------------------------------------------------------
static pthread_mutex_t out_lock = PTHREAD_MUTEX_INITIALIZER;
static int protocol = 1; // off in bench mode

static void write_all(const void *p, size_t n) {
  const uint8_t *b = p;
  while (n) {
    compat_ssize w = compat_write(1, b, n);
    if (w < 0) {
      if (errno == EINTR) continue;
      exit(0); // souldew went away
    }
    b += w;
    n -= (size_t)w;
  }
}

static void send_msg2(uint32_t type, const void *a, uint32_t na, const void *b, uint32_t nb) {
  if (!protocol) return;
  uint32_t h[2] = {type, na + nb};
  pthread_mutex_lock(&out_lock);
  write_all(h, 8);
  if (na) write_all(a, na);
  if (nb) write_all(b, nb);
  pthread_mutex_unlock(&out_lock);
}
static void send_msg(uint32_t type, const void *p, uint32_t n) { send_msg2(type, p, n, NULL, 0); }

static void send_event(const char *fmt, ...) {
  char buf[1024];
  va_list ap;
  va_start(ap, fmt);
  int n = vsnprintf(buf, sizeof buf, fmt, ap);
  va_end(ap);
  if (n > 0) send_msg(7, buf, (uint32_t)(n < (int)sizeof buf ? n : (int)sizeof buf - 1));
}

static void logf_(const char *fmt, ...) {
  char buf[2048];
  va_list ap;
  va_start(ap, fmt);
  int n = vsnprintf(buf, sizeof buf, fmt, ap);
  va_end(ap);
  if (n <= 0) return;
  if (n >= (int)sizeof buf) n = sizeof buf - 1;
  fprintf(stderr, "%s%s", buf, buf[n - 1] == '\n' ? "" : "\n");
  if (protocol) send_msg(6, buf, (uint32_t)n);
}

static void die(const char *fmt, ...) {
  char buf[1024];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(buf, sizeof buf, fmt, ap);
  va_end(ap);
  fprintf(stderr, "ctrhost: %s\n", buf);
  // JSON-safe enough: the messages are ours, without quotes
  send_event("{\"event\":\"error\",\"message\":\"%s\"}", buf);
  exit(1);
}

// ---- the core --------------------------------------------------------------------------------------------------
static struct {
  void (*init)(void);
  void (*deinit)(void);
  void (*set_environment)(retro_environment_t);
  void (*set_video_refresh)(retro_video_refresh_t);
  void (*set_audio_sample)(retro_audio_sample_t);
  void (*set_audio_sample_batch)(retro_audio_sample_batch_t);
  void (*set_input_poll)(retro_input_poll_t);
  void (*set_input_state)(retro_input_state_t);
  void (*get_system_av_info)(struct retro_system_av_info *);
  bool (*load_game)(const struct retro_game_info *);
  void (*unload_game)(void);
  void (*run)(void);
  void (*reset)(void);
  size_t (*serialize_size)(void);
  bool (*serialize)(void *, size_t);
  bool (*unserialize)(const void *, size_t);
} core;

static struct retro_hw_render_callback hw;
static const struct retro_hw_render_context_negotiation_interface_vulkan *negotiation;
static struct retro_memory_descriptor *memmap;
static unsigned memmap_n;
static int frame_w = 400, frame_h = 480;

// ---- input state (written by the reader thread, read by the core) ----------------------------------------------
static pthread_mutex_t in_lock = PTHREAD_MUTEX_INITIALIZER;
static struct {
  uint32_t buttons;
  int16_t lx, ly, rx, ry, px, py;
  uint8_t pressed;
} input;

static int debug_input; // CTRHOST_DEBUG=1: log what the core asks for (first ones)
// A click is often shorter than games look at the touch screen (the 3DS keyboard wants the stylus down for a few
// frames): every touch counts for at least this many frames, at the position it started.
#define TOUCH_MIN_FRAMES 8
static int touch_latch;
static void input_poll(void) {}
static int16_t input_state(unsigned port, unsigned device, unsigned index, unsigned id) {
  if (debug_input > 0 && device != RETRO_DEVICE_JOYPAD) {
    debug_input--;
    fprintf(stderr, "input_state port=%u device=%u index=%u id=%u pressed=%u px=%d py=%d\n", port, device, index, id, input.pressed, input.px, input.py);
  }
  if (port) return 0;
  int16_t v = 0;
  pthread_mutex_lock(&in_lock);
  switch (device) {
  case RETRO_DEVICE_JOYPAD:
    v = id == RETRO_DEVICE_ID_JOYPAD_MASK ? (int16_t)(input.buttons & 0xffff) : (int16_t)((input.buttons >> id) & 1);
    break;
  case RETRO_DEVICE_ANALOG:
    if (index == RETRO_DEVICE_INDEX_ANALOG_LEFT) v = id == RETRO_DEVICE_ID_ANALOG_X ? input.lx : input.ly;
    else if (index == RETRO_DEVICE_INDEX_ANALOG_RIGHT) v = id == RETRO_DEVICE_ID_ANALOG_X ? input.rx : input.ry;
    break;
  case RETRO_DEVICE_POINTER:
    if (index == 0) {
      if (id == RETRO_DEVICE_ID_POINTER_X) v = input.px;
      else if (id == RETRO_DEVICE_ID_POINTER_Y) v = input.py;
      else if (id == RETRO_DEVICE_ID_POINTER_PRESSED) v = input.pressed || touch_latch > 0;
      else if (id == RETRO_DEVICE_ID_POINTER_COUNT) v = input.pressed || touch_latch > 0 ? 1 : 0;
    }
    break;
  }
  pthread_mutex_unlock(&in_lock);
  return v;
}

// ---- audio: collected per frame, sent after it ------------------------------------------------------------------
static int16_t *audio_buf;
static size_t audio_n, audio_cap;
static int audio_on = 1;
static void audio_push(const int16_t *d, size_t frames) {
  if (!audio_on) return;
  if (audio_n + frames * 2 > audio_cap) {
    audio_cap = (audio_n + frames * 2) * 2;
    audio_buf = realloc(audio_buf, audio_cap * sizeof *audio_buf);
  }
  memcpy(audio_buf + audio_n, d, frames * 2 * sizeof *d);
  audio_n += frames * 2;
}
static void audio_sample(int16_t l, int16_t r) {
  int16_t s[2] = {l, r};
  audio_push(s, 1);
}
static size_t audio_batch(const int16_t *d, size_t frames) {
  audio_push(d, frames);
  return frames;
}

// ---- Vulkan ------------------------------------------------------------------------------------------------------
static PFN_vkGetInstanceProcAddr gipa;
static PFN_vkGetDeviceProcAddr gdpa;
static VkInstance instance;
static VkPhysicalDevice gpu;
static struct retro_vulkan_context vkctx;
static struct retro_hw_render_interface_vulkan vkif;
static pthread_mutex_t queue_lock = PTHREAD_MUTEX_INITIALIZER;
static const struct retro_vulkan_image *cur_image;
static const VkCommandBuffer *pending_cmds;
static unsigned pending_n;

#define DEV_FN(name) static PFN_##name name##_
DEV_FN(vkCreateCommandPool); DEV_FN(vkAllocateCommandBuffers); DEV_FN(vkBeginCommandBuffer); DEV_FN(vkEndCommandBuffer);
DEV_FN(vkCmdPipelineBarrier); DEV_FN(vkCmdCopyImageToBuffer); DEV_FN(vkQueueSubmit); DEV_FN(vkCreateFence);
DEV_FN(vkWaitForFences); DEV_FN(vkResetFences); DEV_FN(vkCreateBuffer); DEV_FN(vkGetBufferMemoryRequirements);
DEV_FN(vkAllocateMemory); DEV_FN(vkBindBufferMemory); DEV_FN(vkMapMemory); DEV_FN(vkDestroyBuffer); DEV_FN(vkFreeMemory);
DEV_FN(vkResetCommandBuffer); DEV_FN(vkQueueWaitIdle);
static PFN_vkGetPhysicalDeviceMemoryProperties vkGetPhysicalDeviceMemoryProperties_;

static VkCommandPool cmd_pool;
static VkCommandBuffer cmd;
static VkFence fence;
static VkBuffer rb_buf;
static VkDeviceMemory rb_mem;
static void *rb_ptr;
static VkDeviceSize rb_size;

static uint32_t vk_sync_index(void *h) { (void)h; return 0; }
static uint32_t vk_sync_mask(void *h) { (void)h; return 1; }
static void vk_wait_sync(void *h) { (void)h; }
static void vk_lock(void *h) { (void)h; pthread_mutex_lock(&queue_lock); }
static void vk_unlock(void *h) { (void)h; pthread_mutex_unlock(&queue_lock); }
static void vk_set_image(void *h, const struct retro_vulkan_image *image, uint32_t n, const VkSemaphore *sems, uint32_t qf) {
  (void)h; (void)n; (void)sems; (void)qf;
  cur_image = image;
}
static void vk_set_cmds(void *h, uint32_t n, const VkCommandBuffer *cmds) {
  (void)h;
  pending_cmds = cmds;
  pending_n = n;
}
static void vk_set_signal(void *h, VkSemaphore s) { (void)h; (void)s; }

static void *load_vk(const char *path) {
  void *lib = dlopen(path, RTLD_NOW | RTLD_LOCAL);
  if (!lib) die("Vulkan library not loadable: %s", dlerror());
  gipa = (PFN_vkGetInstanceProcAddr)dlsym(lib, "vkGetInstanceProcAddr");
  if (!gipa) die("vkGetInstanceProcAddr missing in %s", path);
  return lib;
}

static void vk_setup(void) {
  const VkApplicationInfo *app = negotiation && negotiation->get_application_info ? negotiation->get_application_info() : NULL;
  VkApplicationInfo def = {VK_STRUCTURE_TYPE_APPLICATION_INFO, NULL, "souldew", 1, "souldew", 1, VK_API_VERSION_1_1};
  PFN_vkEnumerateInstanceExtensionProperties enum_ext = (PFN_vkEnumerateInstanceExtensionProperties)gipa(NULL, "vkEnumerateInstanceExtensionProperties");
  uint32_t n = 0;
  enum_ext(NULL, &n, NULL);
  VkExtensionProperties *props = calloc(n ? n : 1, sizeof *props);
  enum_ext(NULL, &n, props);
  const char *exts[4];
  uint32_t ne = 0;
  VkInstanceCreateFlags flags = 0;
  for (uint32_t i = 0; i < n; i++) {
    if (!strcmp(props[i].extensionName, VK_KHR_GET_PHYSICAL_DEVICE_PROPERTIES_2_EXTENSION_NAME)) exts[ne++] = VK_KHR_GET_PHYSICAL_DEVICE_PROPERTIES_2_EXTENSION_NAME;
    if (!strcmp(props[i].extensionName, VK_KHR_PORTABILITY_ENUMERATION_EXTENSION_NAME)) {
      exts[ne++] = VK_KHR_PORTABILITY_ENUMERATION_EXTENSION_NAME;
      flags |= VK_INSTANCE_CREATE_ENUMERATE_PORTABILITY_BIT_KHR;
    }
  }
  free(props);
  VkInstanceCreateInfo ici = {VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO, NULL, flags, app ? app : &def, 0, NULL, ne, exts};
  PFN_vkCreateInstance create_instance = (PFN_vkCreateInstance)gipa(NULL, "vkCreateInstance");
  VkResult r = create_instance(&ici, NULL, &instance);
  if (r != VK_SUCCESS) die("vkCreateInstance failed (%d)", r);
  PFN_vkEnumeratePhysicalDevices enum_dev = (PFN_vkEnumeratePhysicalDevices)gipa(instance, "vkEnumeratePhysicalDevices");
  uint32_t nd = 0;
  enum_dev(instance, &nd, NULL);
  if (!nd) die("no Vulkan GPU found");
  VkPhysicalDevice devs[8];
  if (nd > 8) nd = 8;
  enum_dev(instance, &nd, devs);
  gpu = devs[0];
  gdpa = (PFN_vkGetDeviceProcAddr)gipa(instance, "vkGetDeviceProcAddr");
  vkGetPhysicalDeviceMemoryProperties_ = (PFN_vkGetPhysicalDeviceMemoryProperties)gipa(instance, "vkGetPhysicalDeviceMemoryProperties");

  memset(&vkctx, 0, sizeof vkctx);
  if (!negotiation || !negotiation->create_device) die("the core offers no Vulkan device creation");
  if (!negotiation->create_device(&vkctx, instance, gpu, VK_NULL_HANDLE, gipa, NULL, 0, NULL, 0, NULL)) die("the core couldn't create its Vulkan device");

#define LOADD(name) name##_ = (PFN_##name)gdpa(vkctx.device, #name); if (!name##_) die("missing %s", #name)
  LOADD(vkCreateCommandPool); LOADD(vkAllocateCommandBuffers); LOADD(vkBeginCommandBuffer); LOADD(vkEndCommandBuffer);
  LOADD(vkCmdPipelineBarrier); LOADD(vkCmdCopyImageToBuffer); LOADD(vkQueueSubmit); LOADD(vkCreateFence);
  LOADD(vkWaitForFences); LOADD(vkResetFences); LOADD(vkCreateBuffer); LOADD(vkGetBufferMemoryRequirements);
  LOADD(vkAllocateMemory); LOADD(vkBindBufferMemory); LOADD(vkMapMemory); LOADD(vkDestroyBuffer); LOADD(vkFreeMemory);
  LOADD(vkResetCommandBuffer); LOADD(vkQueueWaitIdle);

  VkCommandPoolCreateInfo pci = {VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO, NULL, VK_COMMAND_POOL_CREATE_RESET_COMMAND_BUFFER_BIT, vkctx.queue_family_index};
  vkCreateCommandPool_(vkctx.device, &pci, NULL, &cmd_pool);
  VkCommandBufferAllocateInfo cai = {VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO, NULL, cmd_pool, VK_COMMAND_BUFFER_LEVEL_PRIMARY, 1};
  vkAllocateCommandBuffers_(vkctx.device, &cai, &cmd);
  VkFenceCreateInfo fci = {VK_STRUCTURE_TYPE_FENCE_CREATE_INFO, NULL, 0};
  vkCreateFence_(vkctx.device, &fci, NULL, &fence);

  vkif.interface_type = RETRO_HW_RENDER_INTERFACE_VULKAN;
  vkif.interface_version = RETRO_HW_RENDER_INTERFACE_VULKAN_VERSION;
  vkif.handle = &vkif;
  vkif.instance = instance;
  vkif.gpu = vkctx.gpu ? vkctx.gpu : gpu;
  vkif.device = vkctx.device;
  vkif.get_device_proc_addr = gdpa;
  vkif.get_instance_proc_addr = gipa;
  vkif.queue = vkctx.queue;
  vkif.queue_index = vkctx.queue_family_index;
  vkif.set_image = vk_set_image;
  vkif.get_sync_index = vk_sync_index;
  vkif.get_sync_index_mask = vk_sync_mask;
  vkif.set_command_buffers = vk_set_cmds;
  vkif.wait_sync_index = vk_wait_sync;
  vkif.lock_queue = vk_lock;
  vkif.unlock_queue = vk_unlock;
  vkif.set_signal_semaphore = vk_set_signal;
}

static void ensure_readback(VkDeviceSize size) {
  if (rb_buf && rb_size >= size) return;
  if (rb_buf) {
    vkDestroyBuffer_(vkctx.device, rb_buf, NULL);
    vkFreeMemory_(vkctx.device, rb_mem, NULL);
  }
  VkBufferCreateInfo bci = {VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO, NULL, 0, size, VK_BUFFER_USAGE_TRANSFER_DST_BIT, VK_SHARING_MODE_EXCLUSIVE, 0, NULL};
  vkCreateBuffer_(vkctx.device, &bci, NULL, &rb_buf);
  VkMemoryRequirements req;
  vkGetBufferMemoryRequirements_(vkctx.device, rb_buf, &req);
  VkPhysicalDeviceMemoryProperties mp;
  vkGetPhysicalDeviceMemoryProperties_(vkif.gpu, &mp);
  uint32_t type = UINT32_MAX;
  const VkMemoryPropertyFlags want = VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT;
  for (uint32_t i = 0; i < mp.memoryTypeCount; i++) {
    if ((req.memoryTypeBits & (1u << i)) && (mp.memoryTypes[i].propertyFlags & want) == want) {
      // prefer cached host memory: the CPU reads every byte of it
      if (type == UINT32_MAX || (mp.memoryTypes[i].propertyFlags & VK_MEMORY_PROPERTY_HOST_CACHED_BIT)) type = i;
    }
  }
  if (type == UINT32_MAX) die("no host-visible Vulkan memory");
  VkMemoryAllocateInfo mai = {VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO, NULL, req.size, type};
  if (vkAllocateMemory_(vkctx.device, &mai, NULL, &rb_mem) != VK_SUCCESS) die("readback memory");
  vkBindBufferMemory_(vkctx.device, rb_buf, rb_mem, 0);
  vkMapMemory_(vkctx.device, rb_mem, 0, VK_WHOLE_SIZE, 0, &rb_ptr);
  rb_size = size;
}

/** Copy the core's picture into host memory (waits for the GPU). Returns the pixels, or NULL. */
static const uint8_t *readback(int w, int h, int *bgra) {
  if (!cur_image) return NULL;
  VkImage image = cur_image->create_info.image;
  VkFormat fmt = cur_image->create_info.format;
  *bgra = fmt == VK_FORMAT_B8G8R8A8_UNORM || fmt == VK_FORMAT_B8G8R8A8_SRGB;
  ensure_readback((VkDeviceSize)w * h * 4);
  vkResetCommandBuffer_(cmd, 0);
  VkCommandBufferBeginInfo bi = {VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO, NULL, VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT, NULL};
  vkBeginCommandBuffer_(cmd, &bi);
  VkImageSubresourceRange range = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1};
  VkImageMemoryBarrier to_src = {VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER, NULL, VK_ACCESS_MEMORY_WRITE_BIT | VK_ACCESS_COLOR_ATTACHMENT_WRITE_BIT,
    VK_ACCESS_TRANSFER_READ_BIT, cur_image->image_layout, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, VK_QUEUE_FAMILY_IGNORED, VK_QUEUE_FAMILY_IGNORED, image, range};
  vkCmdPipelineBarrier_(cmd, VK_PIPELINE_STAGE_ALL_COMMANDS_BIT, VK_PIPELINE_STAGE_TRANSFER_BIT, 0, 0, NULL, 0, NULL, 1, &to_src);
  VkBufferImageCopy region = {0, 0, 0, {VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1}, {0, 0, 0}, {(uint32_t)w, (uint32_t)h, 1}};
  vkCmdCopyImageToBuffer_(cmd, image, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, rb_buf, 1, &region);
  VkImageMemoryBarrier back = to_src;
  back.srcAccessMask = VK_ACCESS_TRANSFER_READ_BIT;
  back.dstAccessMask = VK_ACCESS_SHADER_READ_BIT | VK_ACCESS_COLOR_ATTACHMENT_WRITE_BIT;
  back.oldLayout = VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL;
  back.newLayout = cur_image->image_layout;
  vkCmdPipelineBarrier_(cmd, VK_PIPELINE_STAGE_TRANSFER_BIT, VK_PIPELINE_STAGE_ALL_COMMANDS_BIT, 0, 0, NULL, 0, NULL, 1, &back);
  vkEndCommandBuffer_(cmd);
  VkCommandBuffer cmds[9];
  uint32_t nc = 0;
  for (unsigned i = 0; i < pending_n && i < 8; i++) cmds[nc++] = pending_cmds[i];
  pending_n = 0;
  cmds[nc++] = cmd;
  VkSubmitInfo si = {VK_STRUCTURE_TYPE_SUBMIT_INFO, NULL, 0, NULL, NULL, nc, cmds, 0, NULL};
  pthread_mutex_lock(&queue_lock);
  VkResult r = vkQueueSubmit_(vkctx.queue, 1, &si, fence);
  pthread_mutex_unlock(&queue_lock);
  if (r != VK_SUCCESS) return NULL;
  vkWaitForFences_(vkctx.device, 1, &fence, VK_TRUE, UINT64_MAX);
  vkResetFences_(vkctx.device, 1, &fence);
  return rb_ptr;
}

// ---- video -------------------------------------------------------------------------------------------------------
static int want_frame = 1; // turbo: only every n-th picture is read back and sent
static uint8_t *last_frame; // bench: the last picture
static int last_w, last_h, last_bgra;
static uint64_t frames_shown;

static void video_refresh(const void *data, unsigned w, unsigned h, size_t pitch) {
  (void)pitch;
  if (!data || !w || !h) return; // a dupe: nothing new
  if (data != RETRO_HW_FRAME_BUFFER_VALID) return; // the core always renders with Vulkan here
  frame_w = (int)w;
  frame_h = (int)h;
  if (!want_frame) return;
  int bgra = 0;
  const uint8_t *px = readback((int)w, (int)h, &bgra);
  if (!px) return;
  frames_shown++;
  if (!protocol) {
    last_frame = realloc(last_frame, (size_t)w * h * 4);
    memcpy(last_frame, px, (size_t)w * h * 4);
    last_w = (int)w, last_h = (int)h, last_bgra = bgra;
    return;
  }
  uint8_t head[8];
  uint16_t ww = (uint16_t)w, hh = (uint16_t)h;
  uint32_t f = bgra ? 0 : 1;
  memcpy(head, &ww, 2);
  memcpy(head + 2, &hh, 2);
  memcpy(head + 4, &f, 4);
  send_msg2(2, head, 8, px, (uint32_t)(w * h * 4));
}

// ---- environment -------------------------------------------------------------------------------------------------
static void core_log(enum retro_log_level level, const char *fmt, ...) {
  if (level < RETRO_LOG_WARN) return;
  char buf[2048];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(buf, sizeof buf, fmt, ap);
  va_end(ap);
  logf_("[core] %s", buf);
}

static bool environment(unsigned cmd, void *data) {
  if (IS(cmd, RETRO_ENVIRONMENT_GET_CAN_DUPE)) { *(bool *)data = true; return true; }
  if (IS(cmd, RETRO_ENVIRONMENT_SET_PERFORMANCE_LEVEL)) return true;
  if (IS(cmd, RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY)) { *(const char **)data = opt_system; return true; }
  if (IS(cmd, RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY)) { *(const char **)data = opt_save; return true; }
  if (IS(cmd, RETRO_ENVIRONMENT_GET_CORE_ASSETS_DIRECTORY)) { *(const char **)data = opt_system; return true; }
  if (IS(cmd, RETRO_ENVIRONMENT_SET_PIXEL_FORMAT)) return *(enum retro_pixel_format *)data == RETRO_PIXEL_FORMAT_XRGB8888;
  if (IS(cmd, RETRO_ENVIRONMENT_SET_INPUT_DESCRIPTORS) || IS(cmd, RETRO_ENVIRONMENT_SET_CONTROLLER_INFO)) return true;
  if (IS(cmd, RETRO_ENVIRONMENT_SET_HW_RENDER)) {
    struct retro_hw_render_callback *cb = data;
    if (cb->context_type != RETRO_HW_CONTEXT_VULKAN) return false;
    hw = *cb;
    return true;
  }
  if (IS(cmd, RETRO_ENVIRONMENT_GET_PREFERRED_HW_RENDER)) { *(unsigned *)data = RETRO_HW_CONTEXT_VULKAN; return true; }
  if (IS(cmd, RETRO_ENVIRONMENT_SET_HW_RENDER_CONTEXT_NEGOTIATION_INTERFACE)) {
    negotiation = data;
    return true;
  }
  if (IS(cmd, RETRO_ENVIRONMENT_GET_HW_RENDER_INTERFACE)) {
    if (!vkif.device) return false;
    *(const struct retro_hw_render_interface_vulkan **)data = &vkif;
    return true;
  }
  if (IS(cmd, RETRO_ENVIRONMENT_GET_VARIABLE)) {
    struct retro_variable *v = data;
    v->value = core_option(v->key);
    return v->value != NULL;
  }
  if (IS(cmd, RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE)) { *(bool *)data = false; return true; }
  if (IS(cmd, RETRO_ENVIRONMENT_GET_CORE_OPTIONS_VERSION)) { *(unsigned *)data = 0; return true; }
  if (IS(cmd, RETRO_ENVIRONMENT_SET_VARIABLES)) return true;
  if (IS(cmd, RETRO_ENVIRONMENT_SET_SUPPORT_NO_GAME)) return true;
  if (IS(cmd, RETRO_ENVIRONMENT_GET_LOG_INTERFACE)) { ((struct retro_log_callback *)data)->log = core_log; return true; }
  if (IS(cmd, RETRO_ENVIRONMENT_SET_GEOMETRY)) {
    const struct retro_game_geometry *g = data;
    frame_w = (int)g->base_width, frame_h = (int)g->base_height;
    return true;
  }
  if (IS(cmd, RETRO_ENVIRONMENT_SET_SYSTEM_AV_INFO)) return true;
  if (IS(cmd, RETRO_ENVIRONMENT_SET_MEMORY_MAPS)) {
    const struct retro_memory_map *m = data;
    free(memmap);
    memmap_n = m->num_descriptors;
    memmap = calloc(memmap_n ? memmap_n : 1, sizeof *memmap);
    memcpy(memmap, m->descriptors, memmap_n * sizeof *memmap);
    return true;
  }
  if (IS(cmd, RETRO_ENVIRONMENT_SET_SUPPORT_ACHIEVEMENTS) || IS(cmd, RETRO_ENVIRONMENT_SET_SERIALIZATION_QUIRKS)) return true;
  if (IS(cmd, RETRO_ENVIRONMENT_GET_INPUT_BITMASKS)) return true;
  if (IS(cmd, RETRO_ENVIRONMENT_GET_AUDIO_VIDEO_ENABLE)) { *(int *)data = 1 | 2; return true; }
  if (IS(cmd, RETRO_ENVIRONMENT_GET_FASTFORWARDING)) { *(bool *)data = false; return true; }
  if (IS(cmd, RETRO_ENVIRONMENT_GET_LANGUAGE)) { *(unsigned *)data = RETRO_LANGUAGE_ENGLISH; return true; }
  if (IS(cmd, RETRO_ENVIRONMENT_GET_USERNAME)) { *(const char **)data = "souldew"; return true; }
  if (IS(cmd, RETRO_ENVIRONMENT_GET_MESSAGE_INTERFACE_VERSION)) { *(unsigned *)data = 1; return true; }
  if (IS(cmd, RETRO_ENVIRONMENT_SET_MESSAGE)) { logf_("[core message] %s", ((const struct retro_message *)data)->msg); return true; }
  if (IS(cmd, RETRO_ENVIRONMENT_SET_MESSAGE_EXT)) { logf_("[core message] %s", ((const struct retro_message_ext *)data)->msg); return true; }
  if (IS(cmd, RETRO_ENVIRONMENT_GET_TARGET_REFRESH_RATE)) { *(float *)data = 60.0f; return true; }
  if (IS(cmd, RETRO_ENVIRONMENT_SHUTDOWN)) { _exit(0); }
  return false;
}

// ---- memory reads ----------------------------------------------------------------------------------------------
// souldew's build of the core exports these (native/azahar-patch): reads through the game process's page table, so
// the heaps the game allocates after loading are readable too. The official core only has the memory map from load.
static bool (*souldew_read_memory)(uint32_t addr, void *out, uint32_t size);
static uint64_t (*souldew_title_id)(void);

static const uint8_t *mem_at(uint32_t addr, uint32_t len) {
  for (unsigned i = 0; i < memmap_n; i++) {
    const struct retro_memory_descriptor *d = &memmap[i];
    if (!d->ptr || addr < d->start || (uint64_t)addr + len > (uint64_t)d->start + d->len) continue;
    return (const uint8_t *)d->ptr + d->offset + (addr - d->start);
  }
  return NULL;
}

#define MAX_WATCH 16
static struct { uint32_t addr, len; } watch[MAX_WATCH];
static unsigned watch_n;

static void send_mem(void) {
  if (!watch_n) return;
  size_t total = 4;
  for (unsigned i = 0; i < watch_n; i++) total += 8 + watch[i].len;
  uint8_t *b = malloc(total), *p = b;
  uint32_t n = watch_n;
  memcpy(p, &n, 4), p += 4;
  for (unsigned i = 0; i < watch_n; i++) {
    uint32_t len = watch[i].len;
    memcpy(p, &watch[i].addr, 4);
    uint8_t *lenp = p + 4, *data = p + 8;
    if (souldew_read_memory) {
      if (!souldew_read_memory(watch[i].addr, data, len)) len = 0; // unmapped (title screen, another update's address)
    } else {
      const uint8_t *src = mem_at(watch[i].addr, len);
      if (src) memcpy(data, src, len);
      else len = 0;
    }
    memcpy(lenp, &len, 4);
    p = data + len;
  }
  send_msg(4, b, (uint32_t)(p - b));
  free(b);
}

// ---- commands from souldew ---------------------------------------------------------------------------------------
static pthread_mutex_t cmd_lock = PTHREAD_MUTEX_INITIALIZER;
static float speed = 1.0f;
static int want_save, want_quit, want_reset, frameskip = 4;
static uint8_t *load_data;
static size_t load_len;

static int read_full(void *p, size_t n) {
  uint8_t *b = p;
  while (n) {
    compat_ssize r = compat_read(0, b, n);
    if (r == 0) return 0;
    if (r < 0) {
      if (errno == EINTR) continue;
      return 0;
    }
    b += r;
    n -= (size_t)r;
  }
  return 1;
}

static void *reader(void *arg) {
  (void)arg;
  for (;;) {
    uint32_t h[2];
    if (!read_full(h, 8)) break;
    if (h[1] > 512u * 1024 * 1024) break;
    uint8_t *p = h[1] ? malloc(h[1]) : NULL;
    if (h[1] && !read_full(p, h[1])) break;
    pthread_mutex_lock(&cmd_lock);
    switch (h[0]) {
    case 1:
      if (h[1] >= 17) {
        pthread_mutex_lock(&in_lock);
        if (p[16] && !input.pressed) touch_latch = TOUCH_MIN_FRAMES;
        memcpy(&input.buttons, p, 4);
        memcpy(&input.lx, p + 4, 2), memcpy(&input.ly, p + 6, 2), memcpy(&input.rx, p + 8, 2), memcpy(&input.ry, p + 10, 2);
        if (p[16] || !touch_latch) memcpy(&input.px, p + 12, 2), memcpy(&input.py, p + 14, 2);
        input.pressed = p[16];
        pthread_mutex_unlock(&in_lock);
      }
      break;
    case 2: if (h[1] >= 4) memcpy(&speed, p, 4); break;
    case 3: want_save = 1; break;
    case 4: free(load_data); load_data = p; load_len = h[1]; p = NULL; break;
    case 5:
      if (h[1] >= 4) {
        uint32_t n;
        memcpy(&n, p, 4);
        if (n > MAX_WATCH) n = MAX_WATCH;
        if (h[1] >= 4 + n * 8) {
          for (uint32_t i = 0; i < n; i++) {
            memcpy(&watch[i].addr, p + 4 + i * 8, 4);
            memcpy(&watch[i].len, p + 8 + i * 8, 4);
            if (watch[i].len > 64 * 1024) watch[i].len = 64 * 1024;
          }
          watch_n = n;
        }
      }
      break;
    case 6: want_quit = 1; break;
    case 7: want_reset = 1; break;
    case 8: if (h[1] >= 4) { uint32_t v; memcpy(&v, p, 4); frameskip = v ? (int)v : 1; } break;
    }
    pthread_mutex_unlock(&cmd_lock);
    free(p);
  }
  pthread_mutex_lock(&cmd_lock);
  want_quit = 1; // souldew closed the pipe
  pthread_mutex_unlock(&cmd_lock);
  return NULL;
}

// ---- main --------------------------------------------------------------------------------------------------------
static double now_s(void) { return compat_now(); }

static void dump_ppm(const char *path) {
  if (!last_frame) return;
  FILE *f = fopen(path, "wb");
  if (!f) return;
  fprintf(f, "P6\n%d %d\n255\n", last_w, last_h);
  for (int i = 0; i < last_w * last_h; i++) {
    const uint8_t *p = last_frame + i * 4;
    uint8_t rgb[3] = {last_bgra ? p[2] : p[0], p[1], last_bgra ? p[0] : p[2]};
    fwrite(rgb, 1, 3, f);
  }
  fclose(f);
}

#define SYM(field, name) core.field = dlsym(lib, name); if (!core.field) die("%s missing in the core", name)

int main(int argc, char **argv) {
  for (int i = 1; i + 1 < argc; i += 2) {
    if (!strcmp(argv[i], "--core")) opt_core = argv[i + 1];
    else if (!strcmp(argv[i], "--vulkan")) opt_vulkan = argv[i + 1];
    else if (!strcmp(argv[i], "--rom")) opt_rom = argv[i + 1];
    else if (!strcmp(argv[i], "--system")) opt_system = argv[i + 1];
    else if (!strcmp(argv[i], "--save")) opt_save = argv[i + 1];
    else if (!strcmp(argv[i], "--bench")) opt_bench = atoi(argv[i + 1]);
    else if (!strcmp(argv[i], "--dump")) opt_dump = argv[i + 1];
    else if (!strcmp(argv[i], "--scale")) opt_scale = atoi(argv[i + 1]);
  }
  if (!opt_core || !opt_vulkan || !opt_rom || !opt_system || !opt_save) {
    fprintf(stderr, "usage: ctrhost --core <lib> --vulkan <lib> --rom <file> --system <dir> --save <dir> [--scale n] [--bench frames --dump out.ppm]\n");
    return 2;
  }
  if (opt_scale < 1 || opt_scale > 4) opt_scale = 1;
  snprintf(scale_str, sizeof scale_str, "%d", opt_scale);
  if (opt_bench) protocol = 0;
  compat_init();
  if (getenv("CTRHOST_DEBUG")) debug_input = 400;

  load_vk(opt_vulkan);
  void *lib = dlopen(opt_core, RTLD_NOW | RTLD_LOCAL);
  if (!lib) die("core not loadable: %s", dlerror());
  SYM(init, "retro_init"); SYM(deinit, "retro_deinit"); SYM(set_environment, "retro_set_environment");
  SYM(set_video_refresh, "retro_set_video_refresh"); SYM(set_audio_sample, "retro_set_audio_sample");
  SYM(set_audio_sample_batch, "retro_set_audio_sample_batch"); SYM(set_input_poll, "retro_set_input_poll");
  SYM(set_input_state, "retro_set_input_state"); SYM(get_system_av_info, "retro_get_system_av_info");
  SYM(load_game, "retro_load_game"); SYM(unload_game, "retro_unload_game"); SYM(run, "retro_run");
  SYM(reset, "retro_reset"); SYM(serialize_size, "retro_serialize_size"); SYM(serialize, "retro_serialize");
  SYM(unserialize, "retro_unserialize");
  souldew_read_memory = dlsym(lib, "souldew_read_memory");
  souldew_title_id = dlsym(lib, "souldew_title_id");

  core.set_environment(environment);
  core.set_video_refresh(video_refresh);
  core.set_audio_sample(audio_sample);
  core.set_audio_sample_batch(audio_batch);
  core.set_input_poll(input_poll);
  core.set_input_state(input_state);
  core.init();

  struct retro_game_info info = {opt_rom, NULL, 0, NULL};
  if (!core.load_game(&info)) die("the core couldn't load the game");
  if (hw.context_type != RETRO_HW_CONTEXT_VULKAN) die("the core didn't ask for Vulkan");
  vk_setup();
  if (hw.context_reset) hw.context_reset(); // the core loads the game here (Vulkan path)

  struct retro_system_av_info av;
  memset(&av, 0, sizeof av);
  core.get_system_av_info(&av);
  double fps = av.timing.fps > 1 ? av.timing.fps : 60.0;
  send_event("{\"event\":\"loaded\",\"width\":%u,\"height\":%u,\"fps\":%.4f,\"sampleRate\":%.1f,\"maps\":%u,\"memory\":%s}",
             av.geometry.base_width, av.geometry.base_height, fps, av.timing.sample_rate, memmap_n, souldew_read_memory ? "true" : "false");

  if (opt_bench) {
    double t0 = now_s();
    for (int i = 0; i < opt_bench; i++) {
      want_frame = i == opt_bench - 1 || (i % 60) == 0;
      core.run();
    }
    double dt = now_s() - t0;
    fprintf(stderr, "bench: %d frames in %.2f s = %.1f fps (%.0f%% of %.2f), %d×%d, %u memory regions\n", opt_bench, dt, opt_bench / dt,
            100.0 * opt_bench / dt / fps, fps, frame_w, frame_h, memmap_n);
    for (unsigned i = 0; i < memmap_n; i++) fprintf(stderr, "  map %08llx +%08llx\n", (unsigned long long)memmap[i].start, (unsigned long long)memmap[i].len);
    if (souldew_title_id) fprintf(stderr, "title %016llX\n", (unsigned long long)souldew_title_id());
    if (souldew_read_memory) {
      static const uint32_t probe[] = {0x08000000, 0x08CE1CE8, 0x08CFB26C, 0x14000000, 0x30000000, 0x34195E10, 0x33F7FA44};
      for (unsigned i = 0; i < sizeof probe / sizeof *probe; i++) {
        uint8_t b[16];
        bool ok = souldew_read_memory(probe[i], b, 16);
        fprintf(stderr, "  read %08X: %s", probe[i], ok ? "" : "unmapped");
        if (ok) for (int k = 0; k < 16; k++) fprintf(stderr, "%02x", b[k]);
        fprintf(stderr, "\n");
      }
    }
    if (opt_dump) dump_ppm(opt_dump);
    _exit(0);
  }

  pthread_t th;
  pthread_create(&th, NULL, reader, NULL);
  double next = now_s();
  uint64_t frame = 0;
  int memtick = 0;
  double stat_t = now_s();
  uint64_t stat_frames = 0;
  for (;;) {
    pthread_mutex_lock(&cmd_lock);
    float sp = speed;
    int quit = want_quit, save = want_save, reset = want_reset, skip = frameskip;
    uint8_t *ld = load_data;
    size_t ll = load_len;
    want_save = want_reset = 0;
    load_data = NULL;
    pthread_mutex_unlock(&cmd_lock);
    if (quit) break;
    if (reset) core.reset();
    if (ld) {
      bool ok = core.unserialize(ld, ll);
      free(ld);
      send_event("{\"event\":\"stateLoaded\",\"ok\":%s}", ok ? "true" : "false");
    }
    if (save) {
      size_t n = core.serialize_size();
      uint8_t *b = n ? malloc(n) : NULL;
      if (b && core.serialize(b, n)) send_msg(5, b, (uint32_t)n);
      else send_msg(5, NULL, 0);
      free(b);
    }
    if (sp <= 0.0f) { // paused
      compat_sleep(0.01);
      next = now_s();
      continue;
    }
    const int turbo = sp > 1.01f;
    want_frame = !turbo || (frame % (uint64_t)(skip > 0 ? skip : 1)) == 0;
    audio_on = !turbo; // fast-forward: no sound (souldew plays its own turbo music)
    core.run();
    pthread_mutex_lock(&in_lock);
    if (touch_latch > 0) touch_latch--;
    pthread_mutex_unlock(&in_lock);
    frame++;
    stat_frames++;
    if (audio_n) {
      send_msg(3, audio_buf, (uint32_t)(audio_n * sizeof *audio_buf));
      audio_n = 0;
    }
    if (++memtick >= 6) { // ten times a second at normal speed
      memtick = 0;
      send_mem();
      // which title runs (the game, or an applet / the HOME menu in between)
      static uint64_t last_tid = 1;
      uint64_t tid = souldew_title_id ? souldew_title_id() : 0;
      if (tid != last_tid) {
        last_tid = tid;
        send_event("{\"event\":\"title\",\"titleId\":\"%016llX\"}", (unsigned long long)tid);
      }
    }
    double t = now_s();
    if (t - stat_t >= 2.0) {
      send_event("{\"event\":\"stats\",\"fps\":%.1f,\"shown\":%llu}", stat_frames / (t - stat_t), (unsigned long long)frames_shown);
      stat_t = t;
      stat_frames = 0;
    }
    if (sp >= 100.0f) { next = t; continue; } // as fast as it goes
    next += 1.0 / (fps * sp);
    if (next < t - 0.1) next = t; // fell behind (loading): don't race to catch up
    double wait = next - t;
    if (wait > 0) compat_sleep(wait);
  }
  // Not core.unload_game() / deinit(): Azahar's shutdown can crash after the last frame, and there is nothing left to
  // keep – the game wrote its saves to the save folder as it made them.
  fflush(stdout);
  _exit(0);
}
