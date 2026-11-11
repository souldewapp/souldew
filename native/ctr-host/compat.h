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
static void *dlopen(const char *path, int flags) {
  (void)flags;
  // the core's own DLLs (none today) and the Vulkan loader are looked up next to it, then on the system path
  HMODULE m = LoadLibraryExA(path, NULL, LOAD_WITH_ALTERED_SEARCH_PATH);
  if (!m) m = LoadLibraryA(path);
  if (!m) snprintf(compat_dlerr, sizeof compat_dlerr, "LoadLibrary failed (error %lu)", (unsigned long)GetLastError());
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
