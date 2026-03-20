#ifdef __cplusplus
extern "C" {
#endif

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>

#include "moonbit.h"

// Execute a command and capture its stdout output.
// Returns the output as a Bytes, or NULL on failure.
MOONBIT_FFI_EXPORT moonbit_bytes_t
nas_process_capture_output(moonbit_bytes_t cmd) {
  FILE *fp = popen((const char *)cmd, "r");
  if (fp == NULL) {
    return moonbit_make_bytes(0, 0);
  }

  // Read output into a dynamically growing buffer
  size_t capacity = 4096;
  size_t len = 0;
  char *buf = (char *)malloc(capacity);
  if (buf == NULL) {
    pclose(fp);
    return moonbit_make_bytes(0, 0);
  }

  size_t n;
  while ((n = fread(buf + len, 1, capacity - len, fp)) > 0) {
    len += n;
    if (len == capacity) {
      capacity *= 2;
      char *newbuf = (char *)realloc(buf, capacity);
      if (newbuf == NULL) {
        free(buf);
        pclose(fp);
        return moonbit_make_bytes(0, 0);
      }
      buf = newbuf;
    }
  }

  pclose(fp);

  moonbit_bytes_t result = moonbit_make_bytes(len, 0);
  memcpy(result, buf, len);
  free(buf);
  return result;
}

// Execute a command and return its exit code.
// The command inherits stdin/stdout/stderr (interactive).
MOONBIT_FFI_EXPORT int nas_process_exec(moonbit_bytes_t cmd) {
  int status = system((const char *)cmd);
  if (status == -1) {
    return -1;
  }
  return WEXITSTATUS(status);
}

// Execute a command, capture stdout, and return exit code via pointer.
// Returns stdout output as Bytes. Exit code is stored in exit_code_out.
MOONBIT_FFI_EXPORT moonbit_bytes_t
nas_process_capture_with_status(moonbit_bytes_t cmd, int *exit_code_out) {
  FILE *fp = popen((const char *)cmd, "r");
  if (fp == NULL) {
    *exit_code_out = -1;
    return moonbit_make_bytes(0, 0);
  }

  size_t capacity = 4096;
  size_t len = 0;
  char *buf = (char *)malloc(capacity);
  if (buf == NULL) {
    *exit_code_out = -1;
    pclose(fp);
    return moonbit_make_bytes(0, 0);
  }

  size_t n;
  while ((n = fread(buf + len, 1, capacity - len, fp)) > 0) {
    len += n;
    if (len == capacity) {
      capacity *= 2;
      char *newbuf = (char *)realloc(buf, capacity);
      if (newbuf == NULL) {
        free(buf);
        *exit_code_out = -1;
        pclose(fp);
        return moonbit_make_bytes(0, 0);
      }
      buf = newbuf;
    }
  }

  int status = pclose(fp);
  if (status == -1) {
    *exit_code_out = -1;
  } else {
    *exit_code_out = WEXITSTATUS(status);
  }

  moonbit_bytes_t result = moonbit_make_bytes(len, 0);
  memcpy(result, buf, len);
  free(buf);
  return result;
}

#ifdef __cplusplus
}
#endif
