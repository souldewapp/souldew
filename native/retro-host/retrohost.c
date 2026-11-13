// souldew's native host for the DS, GBA and Game Boy: runs a libretro core (melonDS DS, mGBA, Gambatte) as a native
// program – with the core's JIT and all of the computer's speed – and talks to souldew over stdin/stdout like the 3DS
// host (native/ctr-host). The game then plays inside souldew's own player (web/lib/nativeplayer.mjs).
//
//   retrohost --core <lib> --rom <game> --system <dir> --save <dir> [--sram <file>] [--ram ADDR:LEN]…
//             [--option key=value]… [--bench FRAMES [--dump out.ppm] [--speed X]]
//
// Messages are { u32 type, u32 length, payload } (little-endian), both ways.
//   host → souldew   2 VIDEO  u16 width, u16 height, u32 format (0 XRGB8888 = BGRA bytes, 2 RGB565), packed pixels
//                    3 AUDIO  s16 stereo samples – fast-forward: the sound sped up (time-compressed to the real
//                             speed, at most 16×, as RetroArch's audio_fastforward_speedup) and never more than
//                             real time – souldew's turbo mixer (web/lib/turboaudio.mjs) slows it down again
//                    5 STATE  a save state (answer to SAVE; empty when the core couldn't)
//                    6 LOG    text
//                    7 EVENT  json  { event: 'loaded' | 'error' | 'stateLoaded' | 'stats' | 'written', … }
//                    8 RAM    u32 count, count × { u32 addr, u32 len, bytes }  what changed in the --ram regions since
//                             the last RAM message (all of it after RESYNC), between two frames – never torn
//                    9 SRAM   the battery save, whole – when the game saved (and it settled), and on FLUSH / QUIT
//   souldew → host   1 INPUT  u32 joypad bits (RETRO_DEVICE_ID_JOYPAD_*), s16 lx, ly, rx, ry, s16 px, py (pointer,
//                             -0x7fff…0x7fff over the whole picture), u8 pressed
//                    2 SPEED  f32 (1 = normal, 0 = paused, ≥ 100 = as fast as possible)
//                    3 SAVE   –           4 LOAD  state bytes      6 QUIT  –       7 RESET –
//                    9 WRITE  u32 addr, bytes (a cheat: written between two frames into a --ram region)
//                   10 FLUSH  –  (send the battery save now)
//                   11 SRAM   bytes: this battery save instead, then a restart (the save souldew had, given late)
//                   12 RESYNC –  (send all of the RAM next time)
//                   13 STEP   u32 n: run exactly n frames, then pause (tests: a plan's input lands on its frame)
// Events: 'stats' { fps, speed, frame }, 'stepped' { frame } after STEP, 'saved' { size } with each SRAM message.
// Builds on macOS, Linux and Windows (../ctr-host/compat.h); scripts/build-native.mjs builds it.
#include "libretro.h"

#include <errno.h>
#include <math.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "compat.h"

#define EXP RETRO_ENVIRONMENT_EXPERIMENTAL
#define IS(cmd, k) (((cmd) & ~EXP) == ((k) & ~EXP))

static void die(const char *fmt, ...);
static void logf_(const char *fmt, ...);

// ---- options ---------------------------------------------------------------------------------------------------
static const char *opt_core, *opt_rom, *opt_system, *opt_save, *opt_sram, *opt_dump;
static int opt_bench = 0;
static double opt_bench_speed = 0; // bench: 0 = as fast as possible, else paced like the game loop

#define MAX_OPTIONS 64
static struct { char *key, *value; } options[MAX_OPTIONS];
static int options_n;
static const char *core_option(const char *key) {
  for (int i = 0; i < options_n; i++)
    if (!strcmp(options[i].key, key)) return options[i].value;
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
      _exit(0); // souldew went away
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

/** `s` as the inside of a JSON string. */
static void json_escape(char *out, size_t cap, const char *s) {
  size_t o = 0;
  for (; *s && o + 7 < cap; s++) {
    unsigned char c = (unsigned char)*s;
    if (c == '"' || c == '\\') out[o++] = '\\', out[o++] = (char)c;
    else if (c < 0x20) o += (size_t)snprintf(out + o, cap - o, "\\u%04x", c);
    else out[o++] = (char)c;
  }
  out[o] = 0;
}

static void die(const char *fmt, ...) {
  char buf[1024], esc[900];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(buf, sizeof buf, fmt, ap);
  va_end(ap);
  fprintf(stderr, "retrohost: %s\n", buf);
  json_escape(esc, sizeof esc, buf);
  send_event("{\"event\":\"error\",\"message\":\"%s\"}", esc);
  fflush(stderr);
  fflush(stdout);
  _exit(1); // not exit(): the core's exit handlers may hang
}

// ---- the core --------------------------------------------------------------------------------------------------
static struct {
  void (*init)(void);
  void (*set_environment)(retro_environment_t);
  void (*set_video_refresh)(retro_video_refresh_t);
  void (*set_audio_sample)(retro_audio_sample_t);
  void (*set_audio_sample_batch)(retro_audio_sample_batch_t);
  void (*set_input_poll)(retro_input_poll_t);
  void (*set_input_state)(retro_input_state_t);
  void (*get_system_info)(struct retro_system_info *);
  void (*get_system_av_info)(struct retro_system_av_info *);
  void (*set_controller_port_device)(unsigned, unsigned);
  bool (*load_game)(const struct retro_game_info *);
  void (*run)(void);
  void (*reset)(void);
  size_t (*serialize_size)(void);
  bool (*serialize)(void *, size_t);
  bool (*unserialize)(const void *, size_t);
  void *(*get_memory_data)(unsigned);
  size_t (*get_memory_size)(unsigned);
} core;

static struct retro_memory_descriptor *memmap;
static unsigned memmap_n;
static int memmap_dirty; // the core gave a new map (melonDS DS builds a new console on reset): find the RAM again
static enum retro_pixel_format pixfmt = RETRO_PIXEL_FORMAT_0RGB1555;

// ---- input state (written by the reader thread, read by the core) ----------------------------------------------
static pthread_mutex_t in_lock = PTHREAD_MUTEX_INITIALIZER;
static struct {
  uint32_t buttons;
  int16_t lx, ly, rx, ry, px, py;
  uint8_t pressed;
} input;
// A click is often shorter than games look at the touch screen: every touch counts for at least this many frames
#define TOUCH_MIN_FRAMES 4
static int touch_latch;

static void input_poll(void) {}
static int16_t input_state(unsigned port, unsigned device, unsigned index, unsigned id) {
  if (port) return 0;
  int16_t v = 0;
  pthread_mutex_lock(&in_lock);
  switch (device & RETRO_DEVICE_MASK) {
  case RETRO_DEVICE_JOYPAD:
    v = id == RETRO_DEVICE_ID_JOYPAD_MASK ? (int16_t)(input.buttons & 0xffff) : (int16_t)((input.buttons >> id) & 1);
    break;
  case RETRO_DEVICE_ANALOG:
    if (index == RETRO_DEVICE_INDEX_ANALOG_LEFT) v = id == RETRO_DEVICE_ID_ANALOG_X ? input.lx : input.ly;
    else if (index == RETRO_DEVICE_INDEX_ANALOG_RIGHT) v = id == RETRO_DEVICE_ID_ANALOG_X ? input.rx : input.ry;
    break;
  case RETRO_DEVICE_POINTER:
    if (index == 0) {
      const int down = input.pressed || touch_latch > 0;
      if (id == RETRO_DEVICE_ID_POINTER_X) v = input.px;
      else if (id == RETRO_DEVICE_ID_POINTER_Y) v = input.py;
      else if (id == RETRO_DEVICE_ID_POINTER_PRESSED) v = (int16_t)down;
      else if (id == RETRO_DEVICE_ID_POINTER_COUNT) v = down ? 1 : 0;
      else if (id == RETRO_DEVICE_ID_POINTER_IS_OFFSCREEN) v = 0;
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
// fast-forward: the frame's sound averaged down by `ff_k` (box filter, fractional), within a real-time budget
static double ff_k = 1, ff_acc, ff_sum[2], ff_budget;
static size_t ff_cnt;
static int16_t *ff_buf;
static size_t ff_cap;
/** The frame's sound sped up by ff_k (n stereo frames in audio_buf → fewer in ff_buf); returns how many. */
static size_t speed_up_audio(void) {
  const size_t n = audio_n / 2;
  if (ff_cap < n / (ff_k > 1 ? (size_t)ff_k : 1) + 4) {
    size_t cap = n + 4;
    int16_t *b = realloc(ff_buf, cap * 2 * sizeof *b);
    if (!b) return 0;
    ff_buf = b;
    ff_cap = cap;
  }
  size_t out = 0;
  for (size_t i = 0; i < n; i++) {
    ff_sum[0] += audio_buf[i * 2];
    ff_sum[1] += audio_buf[i * 2 + 1];
    ff_cnt++;
    ff_acc += 1;
    if (ff_acc >= ff_k && out < ff_cap) {
      ff_buf[out * 2] = (int16_t)(ff_sum[0] / (double)ff_cnt);
      ff_buf[out * 2 + 1] = (int16_t)(ff_sum[1] / (double)ff_cnt);
      out++;
      ff_acc -= ff_k;
      ff_sum[0] = ff_sum[1] = 0;
      ff_cnt = 0;
    }
  }
  return out;
}
static void audio_push(const int16_t *d, size_t frames) {
  if (!audio_on || !frames) return;
  if (audio_n + frames * 2 > audio_cap) {
    size_t cap = (audio_n + frames * 2) * 2;
    int16_t *b = realloc(audio_buf, cap * sizeof *b);
    if (!b) return;
    audio_buf = b;
    audio_cap = cap;
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

// ---- video ---------------------------------------------------------------------------------------------------------
static int want_frame = 1;
static uint8_t *frame_buf; // 8-byte header + packed pixels of the last picture
static size_t frame_cap;
static int frame_w, frame_h, frame_fmt, frame_new;
static uint64_t frames_shown, frame_no;

static void video_refresh(const void *data, unsigned w, unsigned h, size_t pitch) {
  if (!data || !w || !h || data == RETRO_HW_FRAME_BUFFER_VALID) return; // a dupe: the last picture stays
  if (!want_frame) return;
  const int bpp = pixfmt == RETRO_PIXEL_FORMAT_XRGB8888 ? 4 : 2;
  const size_t row = (size_t)w * bpp, need = 8 + row * h;
  if (need > frame_cap) {
    uint8_t *b = realloc(frame_buf, need);
    if (!b) return;
    frame_buf = b;
    frame_cap = need;
  }
  uint8_t *px = frame_buf + 8;
  for (unsigned y = 0; y < h; y++) memcpy(px + y * row, (const uint8_t *)data + y * pitch, row);
  if (pixfmt == RETRO_PIXEL_FORMAT_0RGB1555) { // → RGB565 (the page knows two formats)
    uint16_t *p = (uint16_t *)px;
    for (size_t i = 0, n = (size_t)w * h; i < n; i++) {
      const uint16_t c = p[i];
      p[i] = (uint16_t)(((c & 0x7c00) << 1) | ((c & 0x03e0) << 1) | ((c & 0x0200) >> 4) | (c & 0x001f));
    }
  }
  frame_w = (int)w, frame_h = (int)h, frame_fmt = bpp == 4 ? 0 : 2, frame_new = 1;
}

static void send_frame(void) {
  if (!frame_new) return;
  frame_new = 0;
  frames_shown++;
  uint16_t ww = (uint16_t)frame_w, hh = (uint16_t)frame_h;
  uint32_t f = (uint32_t)frame_fmt;
  memcpy(frame_buf, &ww, 2);
  memcpy(frame_buf + 2, &hh, 2);
  memcpy(frame_buf + 4, &f, 4);
  send_msg(2, frame_buf, (uint32_t)(8 + (size_t)frame_w * frame_h * (frame_fmt == 0 ? 4 : 2)));
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

static int fastforwarding;
static bool environment(unsigned cmd, void *data) {
  if (IS(cmd, RETRO_ENVIRONMENT_GET_CAN_DUPE)) { *(bool *)data = true; return true; }
  if (IS(cmd, RETRO_ENVIRONMENT_SET_PERFORMANCE_LEVEL)) return true;
  if (IS(cmd, RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY)) { *(const char **)data = opt_system; return true; }
  if (IS(cmd, RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY)) { *(const char **)data = opt_save; return true; }
  if (IS(cmd, RETRO_ENVIRONMENT_GET_CORE_ASSETS_DIRECTORY)) { *(const char **)data = opt_system; return true; }
  if (IS(cmd, RETRO_ENVIRONMENT_SET_PIXEL_FORMAT)) {
    enum retro_pixel_format f = *(enum retro_pixel_format *)data;
    if (f != RETRO_PIXEL_FORMAT_XRGB8888 && f != RETRO_PIXEL_FORMAT_RGB565 && f != RETRO_PIXEL_FORMAT_0RGB1555) return false;
    pixfmt = f;
    return true;
  }
  if (IS(cmd, RETRO_ENVIRONMENT_SET_INPUT_DESCRIPTORS) || IS(cmd, RETRO_ENVIRONMENT_SET_CONTROLLER_INFO)) return true;
  if (IS(cmd, RETRO_ENVIRONMENT_SET_HW_RENDER)) return false; // software rendering only
  if (IS(cmd, RETRO_ENVIRONMENT_GET_PREFERRED_HW_RENDER)) return false;
  if (IS(cmd, RETRO_ENVIRONMENT_GET_VARIABLE)) {
    struct retro_variable *v = data;
    if (!v || !v->key) return false;
    v->value = core_option(v->key);
    return v->value != NULL;
  }
  if (IS(cmd, RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE)) { *(bool *)data = false; return true; }
  if (IS(cmd, RETRO_ENVIRONMENT_GET_CORE_OPTIONS_VERSION)) { *(unsigned *)data = 0; return true; }
  if (IS(cmd, RETRO_ENVIRONMENT_SET_VARIABLES)) return true;
  if (IS(cmd, RETRO_ENVIRONMENT_SET_CORE_OPTIONS_DISPLAY)) return true;
  if (IS(cmd, RETRO_ENVIRONMENT_SET_SUPPORT_NO_GAME)) return true;
  if (IS(cmd, RETRO_ENVIRONMENT_GET_LOG_INTERFACE)) { ((struct retro_log_callback *)data)->log = core_log; return true; }
  if (IS(cmd, RETRO_ENVIRONMENT_SET_GEOMETRY)) return true;
  if (IS(cmd, RETRO_ENVIRONMENT_SET_SYSTEM_AV_INFO)) return true;
  if (IS(cmd, RETRO_ENVIRONMENT_SET_MEMORY_MAPS)) {
    const struct retro_memory_map *m = data;
    free(memmap);
    memmap_n = m->num_descriptors;
    memmap = calloc(memmap_n ? memmap_n : 1, sizeof *memmap);
    if (!memmap) { memmap_n = 0; return false; }
    memcpy(memmap, m->descriptors, memmap_n * sizeof *memmap);
    memmap_dirty = 1;
    return true;
  }
  if (IS(cmd, RETRO_ENVIRONMENT_SET_SUPPORT_ACHIEVEMENTS) || IS(cmd, RETRO_ENVIRONMENT_SET_SERIALIZATION_QUIRKS)) return true;
  if (IS(cmd, RETRO_ENVIRONMENT_GET_INPUT_BITMASKS)) return true;
  if (IS(cmd, RETRO_ENVIRONMENT_GET_AUDIO_VIDEO_ENABLE)) { *(int *)data = 1 | 2; return true; }
  if (IS(cmd, RETRO_ENVIRONMENT_GET_FASTFORWARDING)) { *(bool *)data = fastforwarding != 0; return true; }
  if (IS(cmd, RETRO_ENVIRONMENT_GET_LANGUAGE)) { *(unsigned *)data = RETRO_LANGUAGE_ENGLISH; return true; }
  if (IS(cmd, RETRO_ENVIRONMENT_GET_USERNAME)) { *(const char **)data = "souldew"; return true; }
  if (IS(cmd, RETRO_ENVIRONMENT_GET_MESSAGE_INTERFACE_VERSION)) { *(unsigned *)data = 1; return true; }
  if (IS(cmd, RETRO_ENVIRONMENT_SET_MESSAGE)) { logf_("[core message] %s", ((const struct retro_message *)data)->msg); return true; }
  if (IS(cmd, RETRO_ENVIRONMENT_SET_MESSAGE_EXT)) { logf_("[core message] %s", ((const struct retro_message_ext *)data)->msg); return true; }
  if (IS(cmd, RETRO_ENVIRONMENT_GET_TARGET_REFRESH_RATE)) { *(float *)data = 60.0f; return true; }
  if (IS(cmd, RETRO_ENVIRONMENT_SHUTDOWN)) { fflush(stdout); _exit(0); }
  return false;
}

// ---- memory: the regions the live reader needs, mirrored in the page -----------------------------------------------
#define MAX_RAM 4
#define BLOCK 1024
static struct ram_region { uint32_t addr, len; uint8_t *ptr, *shadow; } ram[MAX_RAM];
static int ram_n, ram_full = 1;

/**
 * Where the bus address `addr` (`len` bytes) lives in the core's memory, from its memory map: a descriptor whose
 * address bits (`select`) match for the first and the last byte, inside its first copy (no mirrors) – a descriptor's
 * `start + len` alone may reach past its window (Gambatte's 32 KB cartridge RAM at 0xA000 "covers" 0xC000 too).
 */
static uint8_t *mem_at(uint32_t addr, uint32_t len) {
  if (!len) return NULL;
  for (unsigned i = 0; i < memmap_n; i++) {
    const struct retro_memory_descriptor *d = &memmap[i];
    if (!d->ptr || !d->len || addr < d->start || (uint64_t)addr + len > (uint64_t)d->start + d->len) continue;
    const uint64_t last = (uint64_t)addr + len - 1;
    if (d->select && ((((uint64_t)addr ^ d->start) & d->select) || ((last ^ d->start) & d->select))) continue;
    return (uint8_t *)d->ptr + d->offset + (addr - d->start);
  }
  return NULL;
}

/** Find the regions in the core's memory: the memory map, else (the first region) the core's system RAM. */
static void resolve_ram(void) {
  for (int i = 0; i < ram_n; i++) {
    uint8_t *p = mem_at(ram[i].addr, ram[i].len);
    if (!p && i == 0 && core.get_memory_data && core.get_memory_size) {
      size_t n = core.get_memory_size(RETRO_MEMORY_SYSTEM_RAM);
      if (n >= ram[i].len) p = core.get_memory_data(RETRO_MEMORY_SYSTEM_RAM);
    }
    if (!p && ram[i].ptr) logf_("memory region %08X+%X not found in the core", ram[i].addr, ram[i].len);
    ram[i].ptr = p;
    if (p && !ram[i].shadow) ram[i].shadow = calloc(1, ram[i].len);
  }
}

static uint8_t *ram_msg;
static size_t ram_msg_cap;
/** What changed since the last time (everything after RESYNC), in runs of whole blocks. */
static void send_ram(void) {
  resolve_ram(); // (cheap – and a core may move its memory without a new map: Gambatte after loading)
  size_t cap = 4;
  for (int i = 0; i < ram_n; i++) cap += ram[i].len + 8 * (ram[i].len / BLOCK + 1);
  if (cap > ram_msg_cap) {
    uint8_t *b = realloc(ram_msg, cap);
    if (!b) return;
    ram_msg = b;
    ram_msg_cap = cap;
  }
  uint8_t *p = ram_msg + 4;
  uint32_t count = 0;
  for (int i = 0; i < ram_n; i++) {
    struct ram_region *r = &ram[i];
    if (!r->ptr || !r->shadow) continue;
    uint32_t at = 0;
    while (at < r->len) {
      uint32_t n = r->len - at < BLOCK ? r->len - at : BLOCK;
      if (!ram_full && !memcmp(r->ptr + at, r->shadow + at, n)) { at += n; continue; }
      uint32_t start = at; // a run of changed blocks
      while (at < r->len) {
        n = r->len - at < BLOCK ? r->len - at : BLOCK;
        if (!ram_full && !memcmp(r->ptr + at, r->shadow + at, n)) break;
        memcpy(r->shadow + at, r->ptr + at, n);
        at += n;
      }
      uint32_t addr = r->addr + start, len = at - start;
      memcpy(p, &addr, 4);
      memcpy(p + 4, &len, 4);
      memcpy(p + 8, r->shadow + start, len);
      p += 8 + len;
      count++;
    }
  }
  ram_full = 0;
  if (!count) return;
  memcpy(ram_msg, &count, 4);
  send_msg(8, ram_msg, (uint32_t)(p - ram_msg));
}

/** A cheat: bytes into one region (all of them inside it, or nothing). */
static int ram_write(uint32_t addr, const uint8_t *b, uint32_t len) {
  for (int i = 0; i < ram_n; i++) {
    const struct ram_region *r = &ram[i];
    if (!r->ptr || addr < r->addr || (uint64_t)addr + len > (uint64_t)r->addr + r->len) continue;
    memcpy(r->ptr + (addr - r->addr), b, len);
    return 1;
  }
  return 0;
}

// ---- the battery save -------------------------------------------------------------------------------------------
static uint64_t sram_sent, sram_seen; // hashes: what souldew has, what the last look saw
static uint64_t fnv(const uint8_t *p, size_t n) {
  uint64_t h = 1469598103934665603ull;
  for (size_t i = 0; i < n; i++) h = (h ^ p[i]) * 1099511628211ull;
  return h;
}
static void sram_get(uint8_t **p, size_t *n) {
  *p = core.get_memory_data ? core.get_memory_data(RETRO_MEMORY_SAVE_RAM) : NULL;
  *n = *p && core.get_memory_size ? core.get_memory_size(RETRO_MEMORY_SAVE_RAM) : 0;
  if (!*n) *p = NULL;
}
/** Send the battery save when it changed: `force` now, else once it stopped changing (the game writes it in steps). */
static void check_sram(int force) {
  uint8_t *p;
  size_t n;
  sram_get(&p, &n);
  if (!p) return;
  uint64_t h = fnv(p, n);
  const int settled = h == sram_seen;
  sram_seen = h;
  if (h == sram_sent || (!force && !settled)) return;
  sram_sent = h;
  send_msg(9, p, (uint32_t)n);
  send_event("{\"event\":\"saved\",\"size\":%zu}", n);
}
/** The save souldew hands over at the start, into the core's save memory (as RetroArch does with .srm files). */
static void load_sram(void) {
  uint8_t *p;
  size_t n;
  sram_get(&p, &n);
  if (!p) return;
  if (opt_sram && *opt_sram) {
    FILE *f = fopen(opt_sram, "rb");
    if (f) {
      size_t got = fread(p, 1, n, f);
      fclose(f);
      logf_("battery save: %zu of %zu bytes", got, n);
    }
  }
  sram_sent = sram_seen = fnv(p, n); // souldew has this one
}

// ---- commands from souldew ---------------------------------------------------------------------------------------
static pthread_mutex_t cmd_lock = PTHREAD_MUTEX_INITIALIZER;
static float speed = 1.0f;
static int want_save, want_quit, want_reset, want_flush, want_resync;
static uint8_t *load_data, *sram_data;
static size_t load_len, sram_len;
static uint32_t step_left; // STEP: frames still to run before pausing
#define MAX_WRITES 64
static struct { uint32_t addr, len; uint8_t *b; } writes[MAX_WRITES];
static int writes_n;

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
    if (h[1] > 256u * 1024 * 1024) break;
    uint8_t *p = h[1] ? malloc(h[1]) : NULL;
    if (h[1] && !p) break;
    if (h[1] && !read_full(p, h[1])) {
      free(p);
      break;
    }
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
    case 2:
      if (h[1] >= 4) {
        float v;
        memcpy(&v, p, 4);
        speed = isfinite(v) ? (v <= 0 ? 0 : v < 0.05f ? 0.05f : v > 1000.0f ? 1000.0f : v) : v > 0 ? 1000.0f : 1.0f;
      }
      break;
    case 3: want_save = 1; break;
    case 4: free(load_data); load_data = p; load_len = h[1]; p = NULL; break;
    case 6: want_quit = 1; break;
    case 7: want_reset = 1; break;
    case 9:
      if (h[1] > 4 && h[1] <= 4 + 65536 && writes_n >= MAX_WRITES) {
        uint32_t a;
        memcpy(&a, p, 4);
        send_event("{\"event\":\"written\",\"addr\":%u,\"len\":%u,\"ok\":false}", a, h[1] - 4); // (too many at once)
      } else if (h[1] > 4 && h[1] <= 4 + 65536) {
        memcpy(&writes[writes_n].addr, p, 4);
        writes[writes_n].len = h[1] - 4;
        writes[writes_n].b = p; // (freed after it is written)
        writes_n++;
        p = NULL;
      }
      break;
    case 10: want_flush = 1; break;
    case 11: free(sram_data); sram_data = p; sram_len = h[1]; p = NULL; break;
    case 12: want_resync = 1; break;
    case 13:
      if (h[1] >= 4) {
        uint32_t n;
        memcpy(&n, p, 4);
        step_left = n > 100000 ? 100000 : n;
        speed = step_left ? 1000.0f : 0.0f; // as fast as it goes, then paused
      }
      break;
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
static void dump_ppm(const char *path) {
  if (!frame_buf || !frame_w) return;
  FILE *f = fopen(path, "wb");
  if (!f) return;
  fprintf(f, "P6\n%d %d\n255\n", frame_w, frame_h);
  const uint8_t *px = frame_buf + 8;
  for (int i = 0; i < frame_w * frame_h; i++) {
    uint8_t rgb[3];
    if (frame_fmt == 0) rgb[0] = px[i * 4 + 2], rgb[1] = px[i * 4 + 1], rgb[2] = px[i * 4];
    else {
      uint16_t c;
      memcpy(&c, px + i * 2, 2);
      rgb[0] = (uint8_t)((c >> 11) << 3), rgb[1] = (uint8_t)(((c >> 5) & 63) << 2), rgb[2] = (uint8_t)((c & 31) << 3);
    }
    fwrite(rgb, 1, 3, f);
  }
  fclose(f);
}

static void *read_file(const char *path, size_t *n) {
  FILE *f = fopen(path, "rb");
  if (!f) return NULL;
  fseek(f, 0, SEEK_END);
  long len = ftell(f);
  fseek(f, 0, SEEK_SET);
  void *b = len > 0 ? malloc((size_t)len) : NULL;
  if (b && fread(b, 1, (size_t)len, f) != (size_t)len) {
    free(b);
    b = NULL;
  }
  fclose(f);
  *n = b ? (size_t)len : 0;
  return b;
}

#define SYM(field, name) core.field = (void *)dlsym(lib, name); if (!core.field) die("%s missing in the core", name)

int main(int argc, char **argv) {
  argv = compat_utf8_argv(&argc, argv);
  for (int i = 1; i + 1 < argc; i += 2) {
    const char *k = argv[i], *v = argv[i + 1];
    if (!strcmp(k, "--core")) opt_core = v;
    else if (!strcmp(k, "--rom")) opt_rom = v;
    else if (!strcmp(k, "--system")) opt_system = v;
    else if (!strcmp(k, "--save")) opt_save = v;
    else if (!strcmp(k, "--sram")) opt_sram = v;
    else if (!strcmp(k, "--bench")) opt_bench = atoi(v);
    else if (!strcmp(k, "--speed")) opt_bench_speed = atof(v);
    else if (!strcmp(k, "--dump")) opt_dump = v;
    else if (!strcmp(k, "--ram") && ram_n < MAX_RAM) {
      char *end = NULL;
      unsigned long a = strtoul(v, &end, 0), n = end && *end == ':' ? strtoul(end + 1, NULL, 0) : 0;
      if (n > 0 && n <= 16u * 1024 * 1024 && a + n <= 0xffffffffull) ram[ram_n].addr = (uint32_t)a, ram[ram_n].len = (uint32_t)n, ram_n++;
    } else if (!strcmp(k, "--option") && options_n < MAX_OPTIONS) {
      const char *eq = strchr(v, '=');
      if (eq && eq > v) {
        options[options_n].key = calloc(1, (size_t)(eq - v) + 1);
        memcpy(options[options_n].key, v, (size_t)(eq - v));
        options[options_n].value = strdup(eq + 1);
        options_n++;
      }
    }
  }
  if (!opt_core || !opt_rom || !opt_system || !opt_save) {
    fprintf(stderr, "usage: retrohost --core <lib> --rom <file> --system <dir> --save <dir> [--sram <file>] [--ram addr:len]… [--option k=v]… [--bench frames [--speed x] [--dump out.ppm]]\n");
    return 2;
  }
  if (opt_bench) protocol = 0;
  compat_init();

  void *lib = dlopen(opt_core, RTLD_NOW | RTLD_LOCAL);
  if (!lib) die("core not loadable: %s", dlerror());
  SYM(init, "retro_init"); SYM(set_environment, "retro_set_environment");
  SYM(set_video_refresh, "retro_set_video_refresh"); SYM(set_audio_sample, "retro_set_audio_sample");
  SYM(set_audio_sample_batch, "retro_set_audio_sample_batch"); SYM(set_input_poll, "retro_set_input_poll");
  SYM(set_input_state, "retro_set_input_state"); SYM(get_system_info, "retro_get_system_info");
  SYM(get_system_av_info, "retro_get_system_av_info"); SYM(load_game, "retro_load_game"); SYM(run, "retro_run");
  SYM(reset, "retro_reset"); SYM(serialize_size, "retro_serialize_size"); SYM(serialize, "retro_serialize");
  SYM(unserialize, "retro_unserialize"); SYM(get_memory_data, "retro_get_memory_data");
  SYM(get_memory_size, "retro_get_memory_size");
  core.set_controller_port_device = (void *)dlsym(lib, "retro_set_controller_port_device");

  core.set_environment(environment);
  core.set_video_refresh(video_refresh);
  core.set_audio_sample(audio_sample);
  core.set_audio_sample_batch(audio_batch);
  core.set_input_poll(input_poll);
  core.set_input_state(input_state);
  core.init();

  struct retro_system_info sys;
  memset(&sys, 0, sizeof sys);
  core.get_system_info(&sys);
  struct retro_game_info info = {opt_rom, NULL, 0, NULL};
  void *rom_data = NULL;
  if (sys.need_fullpath == false) { // the core wants the bytes (mGBA, Gambatte)
    rom_data = read_file(opt_rom, &info.size);
    if (!rom_data) die("game not readable: %s", opt_rom);
    // A DS cartridge is a power of two in size; a trimmed or patched ROM (Renegade Platinum: 104,923,028 bytes) isn't.
    // melonDS rounds the size up and then reads past the end of the buffer – it crashes inside its fault handler and
    // hangs. Padded with 0xFF, as an unused cartridge area reads, the game starts.
    if (sys.library_name && strstr(sys.library_name, "melonDS") && info.size > 0 && (info.size & (info.size - 1))) {
      size_t want = 1;
      while (want < info.size) want <<= 1;
      void *b = realloc(rom_data, want);
      if (!b) die("not enough memory for the game");
      memset((uint8_t *)b + info.size, 0xff, want - info.size);
      fprintf(stderr, "retrohost: ROM padded from %zu to %zu bytes\n", info.size, want);
      rom_data = b;
      info.size = want;
    }
    info.data = rom_data;
  }
  if (!core.load_game(&info)) die("the core couldn't load the game");
  if (core.set_controller_port_device) core.set_controller_port_device(0, RETRO_DEVICE_JOYPAD);
  load_sram();
  resolve_ram();

  struct retro_system_av_info av;
  memset(&av, 0, sizeof av);
  core.get_system_av_info(&av);
  double fps = av.timing.fps > 1 ? av.timing.fps : 60.0;
  uint8_t *sp;
  size_t sn;
  sram_get(&sp, &sn);
  {
    char regions[256] = "";
    size_t o = 0;
    for (int i = 0; i < ram_n && o < sizeof regions - 40; i++)
      o += (size_t)snprintf(regions + o, sizeof regions - o, "%s{\"addr\":%u,\"len\":%u,\"ok\":%s}", i ? "," : "", ram[i].addr, ram[i].len, ram[i].ptr ? "true" : "false");
    char name[200];
    json_escape(name, sizeof name, sys.library_name ? sys.library_name : "?");
    char ver[120];
    json_escape(ver, sizeof ver, sys.library_version ? sys.library_version : "?");
    send_event("{\"event\":\"loaded\",\"core\":\"%s\",\"version\":\"%s\",\"width\":%u,\"height\":%u,\"fps\":%.4f,\"sampleRate\":%.1f,\"ram\":[%s],\"saveSize\":%zu,\"stateSize\":%zu}",
               name, ver, av.geometry.base_width, av.geometry.base_height, fps, av.timing.sample_rate, regions, sn, core.serialize_size());
  }

  if (opt_bench) {
    double t0 = compat_now(), next = t0;
    for (int i = 0; i < opt_bench; i++) {
      want_frame = i == opt_bench - 1 || (i % 60) == 0;
      core.run();
      audio_n = 0;
      if (opt_bench_speed > 0) {
        next += 1.0 / (fps * opt_bench_speed);
        double w = next - compat_now();
        if (w > 0) compat_sleep(w);
      }
    }
    double dt = compat_now() - t0;
    fprintf(stderr, "bench: %d frames in %.2f s = %.1f fps (%.0f%% = %.2fx of %.2f), %dx%d fmt %d, sram %zu, state %zu\n", opt_bench, dt, opt_bench / dt,
            100.0 * opt_bench / dt / fps, opt_bench / dt / fps, fps, frame_w, frame_h, frame_fmt, sn, core.serialize_size());
    for (int i = 0; i < ram_n; i++) {
      fprintf(stderr, "  ram %08X+%X: %s", ram[i].addr, ram[i].len, ram[i].ptr ? "" : "missing");
      if (ram[i].ptr) for (int k = 0; k < 16; k++) fprintf(stderr, "%02x", ram[i].ptr[k]);
      fprintf(stderr, "\n");
    }
    if (opt_dump) dump_ppm(opt_dump);
    fflush(stderr);
    _exit(0);
  }

  pthread_t th;
  pthread_create(&th, NULL, reader, NULL);
  double next = compat_now(), last_frame = 0, last_ram = 0, last_sram = compat_now(), stat_t = compat_now(), last_audio = compat_now();
  const double sample_rate = av.timing.sample_rate > 0 ? av.timing.sample_rate : 32768;
  uint64_t stat_frames = 0;
  for (;;) {
    pthread_mutex_lock(&cmd_lock);
    float spd = speed;
    uint32_t steps = step_left;
    int quit = want_quit, save = want_save, reset = want_reset, flush = want_flush;
    if (want_resync) ram_full = 1;
    uint8_t *ld = load_data, *sd = sram_data;
    size_t ll = load_len, sl = sram_len;
    want_save = want_reset = want_flush = want_resync = 0;
    load_data = sram_data = NULL;
    int nw = writes_n;
    writes_n = 0;
    for (int i = 0; i < nw; i++) {
      int ok = ram_write(writes[i].addr, writes[i].b + 4, writes[i].len);
      send_event("{\"event\":\"written\",\"addr\":%u,\"len\":%u,\"ok\":%s}", writes[i].addr, writes[i].len, ok ? "true" : "false");
      free(writes[i].b);
    }
    pthread_mutex_unlock(&cmd_lock);
    if (quit) break;
    if (reset || sd) {
      core.reset();
      memmap_dirty = 1;
    }
    if (sd) {
      // a battery save given late: the game starts over with it. Written after the reset – melonDS DS builds a new
      // console there and copies the old one's save into its buffer; the next frame installs what is in it then.
      uint8_t *p;
      size_t n;
      sram_get(&p, &n);
      if (p) {
        memset(p, 0xff, n);
        memcpy(p, sd, sl < n ? sl : n);
        sram_sent = sram_seen = fnv(p, n);
      }
      free(sd);
    }
    if (ld) {
      // a state far off the core's own size is no state of this game (cores trust the sizes inside it)
      const size_t want = core.serialize_size();
      bool ok = want && ll >= want / 2 && ll <= want * 2 + 65536 && core.unserialize(ld, ll);
      free(ld);
      memmap_dirty = 1;
      send_event("{\"event\":\"stateLoaded\",\"ok\":%s}", ok ? "true" : "false");
    }
    if (memmap_dirty) memmap_dirty = 0, resolve_ram();
    if (save) {
      size_t n = core.serialize_size();
      uint8_t *b = n ? malloc(n) : NULL;
      if (b && core.serialize(b, n)) send_msg(5, b, (uint32_t)n);
      else send_msg(5, NULL, 0);
      free(b);
    }
    if (flush) check_sram(1);
    double t = compat_now();
    if (spd <= 0.0f) { // paused: the RAM and the save stay current (cheats, a save state's check)
      if (t - last_ram >= 0.1 || nw) last_ram = t, send_ram();
      if (t - last_sram >= 0.5) last_sram = t, check_sram(0); // a save made right before the pause still settles
      compat_sleep(0.01);
      next = compat_now();
      continue;
    }
    const int turbo = spd > 1.01f;
    static int was_turbo;
    if (turbo != was_turbo) { // a fresh start for the sped-up sound: the asked-for speed until it is measured
      was_turbo = turbo;
      ff_k = turbo ? (spd > 16 ? 16 : spd) : 1;
      ff_acc = ff_sum[0] = ff_sum[1] = 0;
      ff_cnt = 0;
      ff_budget = sample_rate * 0.05;
    }
    fastforwarding = turbo;
    // turbo: a picture for the screen about 60 times a second, not one per emulated frame
    want_frame = !turbo || t - last_frame >= 1.0 / 62 || steps == 1;
    audio_on = 1;
    core.run();
    frame_no++;
    pthread_mutex_lock(&in_lock);
    if (touch_latch > 0) touch_latch--;
    pthread_mutex_unlock(&in_lock);
    stat_frames++;
    pthread_mutex_lock(&cmd_lock);
    int stepped = step_left && --step_left == 0;
    if (stepped) speed = 0.0f;
    pthread_mutex_unlock(&cmd_lock);
    t = compat_now();
    if (stepped) { // the plan's next input applies from the next frame: the RAM and the picture as they are now
      send_frame();
      send_ram();
      last_ram = t;
      send_event("{\"event\":\"stepped\",\"frame\":%llu}", (unsigned long long)frame_no);
    }
    if (want_frame && frame_new) last_frame = t, send_frame();
    if (audio_n && !turbo) {
      send_msg(3, audio_buf, (uint32_t)(audio_n * sizeof *audio_buf));
      ff_budget = 0;
    } else if (audio_n) {
      // fast-forward: sped up by the real speed (≤ 16×); what doesn't fit in real time is left out, in whole frames
      ff_budget += (t - last_audio) * sample_rate;
      if (ff_budget > sample_rate * 0.2) ff_budget = sample_rate * 0.2;
      const size_t m = speed_up_audio();
      if (m && ff_budget >= (double)m) {
        ff_budget -= (double)m;
        send_msg(3, ff_buf, (uint32_t)(m * 2 * sizeof *ff_buf));
      }
    }
    audio_n = 0;
    last_audio = t;
    if (t - last_ram >= 0.1 || nw) last_ram = t, send_ram(); // ten times a second, whatever the speed
    if (t - last_sram >= 0.25) last_sram = t, check_sram(0); // (sent once it held still for a quarter second)
    if (t - stat_t >= 0.25) { // four times a second: the page measures the real speed with the frame count
      const double real = stat_frames / (t - stat_t) / fps;
      ff_k = turbo ? (real < 1 ? 1 : real > 16 ? 16 : real) : 1;
      send_event("{\"event\":\"stats\",\"fps\":%.1f,\"speed\":%.3f,\"shown\":%llu,\"frame\":%llu}", stat_frames / (t - stat_t), stat_frames / (t - stat_t) / fps, (unsigned long long)frames_shown, (unsigned long long)frame_no);
      stat_t = t;
      stat_frames = 0;
    }
    if (spd >= 100.0f) { next = t; continue; } // as fast as it goes
    next += 1.0 / (fps * spd);
    if (next < t - 0.1) next = t; // fell behind: don't race to catch up
    double wait = next - t;
    if (wait > 0.1) wait = 0.1, next = t + 0.1; // (commands are read between frames – never sleep long)
    if (wait > 0) compat_sleep(wait);
  }
  check_sram(1); // the last of the game's saves
  fflush(stdout);
  _exit(0);
}
