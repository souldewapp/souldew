// The few OS calls ctrhost.c needs, for macOS / Linux (POSIX) and Windows (MinGW-w64 or clang). Everything else in the
// host is plain C and the libretro / Vulkan APIs.
#ifndef CTRHOST_COMPAT_H
#define CTRHOST_COMPAT_H

#include <stdint.h>
#include <stdio.h>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <fcntl.h>
#include <io.h>
#include <process.h>
#include <stdlib.h>

// libraries
#define RTLD_NOW 0
#define RTLD_LOCAL 0
static char compat_dlerr[256];
/** UTF-8 → UTF-16 (a new string, or NULL). */
static wchar_t *compat_wide(const char *s) {
  int n = MultiByteToWideChar(CP_UTF8, 0, s, -1, NULL, 0);
  wchar_t *w = n > 0 ? malloc((size_t)n * sizeof *w) : NULL;
  if (w && !MultiByteToWideChar(CP_UTF8, 0, s, -1, w, n)) {
    free(w);
    w = NULL;
  }
  return w;
}
static void *dlopen(const char *path, int flags) {
  (void)flags;
  // paths are UTF-8 (compat_utf8_argv): the install folder may hold letters the ANSI code page hasn't
  wchar_t *w = compat_wide(path);
  if (!w) {
    snprintf(compat_dlerr, sizeof compat_dlerr, "invalid path");
    return NULL;
  }
  // a full path: the core's own DLLs (none today) are looked up next to it, then on the system path (the altered
  // search order is only defined for absolute paths – "vulkan-1.dll" takes the normal one)
  const int absolute = (w[0] && w[1] == L':') || w[0] == L'\\' || w[0] == L'/';
  HMODULE m = absolute ? LoadLibraryExW(w, NULL, LOAD_WITH_ALTERED_SEARCH_PATH) : NULL;
  if (!m) m = LoadLibraryW(w);
  if (!m) snprintf(compat_dlerr, sizeof compat_dlerr, "LoadLibrary failed (error %lu)", (unsigned long)GetLastError());
  free(w);
  return (void *)m;
}
static void *dlsym(void *lib, const char *name) { return (void *)(uintptr_t)GetProcAddress((HMODULE)lib, name); }
static const char *dlerror(void) { return compat_dlerr; }

// locks and the command reader thread
typedef SRWLOCK pthread_mutex_t;
#define PTHREAD_MUTEX_INITIALIZER SRWLOCK_INIT
static int pthread_mutex_lock(pthread_mutex_t *m) { AcquireSRWLockExclusive(m); return 0; }
static int pthread_mutex_unlock(pthread_mutex_t *m) { ReleaseSRWLockExclusive(m); return 0; }
typedef HANDLE pthread_t;
typedef struct { void *(*fn)(void *); void *arg; } compat_thread_start;
static unsigned __stdcall compat_thread_main(void *p) {
  compat_thread_start s = *(compat_thread_start *)p;
  free(p);
  s.fn(s.arg);
  return 0;
}
static int pthread_create(pthread_t *t, void *attr, void *(*fn)(void *), void *arg) {
  (void)attr;
  compat_thread_start *s = malloc(sizeof *s);
  if (!s) return -1;
  s->fn = fn;
  s->arg = arg;
  *t = (HANDLE)_beginthreadex(NULL, 0, compat_thread_main, s, 0, NULL);
  return *t ? 0 : -1;
}

// the protocol runs over stdin / stdout: binary, unbuffered
typedef long long compat_ssize;
static compat_ssize compat_read(int fd, void *b, size_t n) { return _read(fd, b, (unsigned)(n > 0x40000000 ? 0x40000000 : n)); }
static compat_ssize compat_write(int fd, const void *b, size_t n) { return _write(fd, b, (unsigned)(n > 0x40000000 ? 0x40000000 : n)); }
static void compat_init(void) {
  _setmode(0, _O_BINARY);
  _setmode(1, _O_BINARY);
  // 1 ms timer resolution: frame pacing at 60 fps needs sleeps shorter than the default 15.6 ms tick
  typedef UINT(WINAPI * tbp)(UINT);
  HMODULE winmm = LoadLibraryA("winmm.dll");
  tbp begin = winmm ? (tbp)(uintptr_t)GetProcAddress(winmm, "timeBeginPeriod") : NULL;
  if (begin) begin(1);
}

// The arguments as UTF-8: libretro cores take UTF-8 paths (Azahar opens them as such), main()'s argv is in the ANSI
// code page – a user name like "Jürgen" (or any letter that code page lacks) broke the ROM / save / system paths.
static char **compat_utf8_argv(int *argc, char **argv) {
  typedef LPWSTR *(WINAPI * c2a_t)(LPCWSTR, int *);
  HMODULE sh = LoadLibraryA("shell32.dll");
  c2a_t c2a = sh ? (c2a_t)(uintptr_t)GetProcAddress(sh, "CommandLineToArgvW") : NULL;
  int n = 0;
  LPWSTR *w = c2a ? c2a(GetCommandLineW(), &n) : NULL;
  if (!w || n < 1) return argv;
  char **out = calloc((size_t)n + 1, sizeof *out);
  if (!out) return argv;
  for (int i = 0; i < n; i++) {
    int len = WideCharToMultiByte(CP_UTF8, 0, w[i], -1, NULL, 0, NULL, NULL);
    out[i] = len > 0 ? malloc((size_t)len) : NULL;
    if (!out[i] || !WideCharToMultiByte(CP_UTF8, 0, w[i], -1, out[i], len, NULL, NULL)) return argv;
  }
  *argc = n;
  return out;
}

// time
static double compat_now(void) {
  static LARGE_INTEGER freq;
  LARGE_INTEGER c;
  if (!freq.QuadPart) QueryPerformanceFrequency(&freq);
  QueryPerformanceCounter(&c);
  return (double)c.QuadPart / (double)freq.QuadPart;
}
static void compat_sleep(double s) {
  if (s <= 0) return;
  double until = compat_now() + s;
  // sleep most of it, spin the last bit (Sleep's granularity is ~1 ms even with timeBeginPeriod)
  if (s > 0.002) Sleep((DWORD)((s - 0.0015) * 1000));
  while (compat_now() < until) SwitchToThread();
}

#else // POSIX
#include <dlfcn.h>
#include <pthread.h>
#include <time.h>
#include <unistd.h>

typedef ssize_t compat_ssize;
static compat_ssize compat_read(int fd, void *b, size_t n) { return read(fd, b, n); }
static compat_ssize compat_write(int fd, const void *b, size_t n) { return write(fd, b, n); }
static void compat_init(void) {}
static char **compat_utf8_argv(int *argc, char **argv) { (void)argc; return argv; } // already bytes as given
static double compat_now(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return (double)t.tv_sec + t.tv_nsec / 1e9;
}
static void compat_sleep(double s) {
  if (s > 0) usleep((useconds_t)(s * 1e6));
}
#endif

#endif
