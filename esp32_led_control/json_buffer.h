#pragma once
#include <stdarg.h>
#include <stdio.h>
#include <stddef.h>

// Fixed-size JSON output shared by serial and HTTP, including SSID escaping.
class JsonBuffer {
 public:
  char* data;
  size_t capacity, length = 0;
  bool valid = true;
  JsonBuffer(char* output, size_t size) : data(output), capacity(size) {
    if (capacity) data[0] = 0;
    else valid = false;
  }
  void add(const char* format, ...) {
    if (!valid) return;
    va_list args;
    va_start(args, format);
    const int written = vsnprintf(data + length, capacity - length, format, args);
    va_end(args);
    if (written < 0 || size_t(written) >= capacity - length) { valid = false; return; }
    length += size_t(written);
  }
  void string(const char* value) {
    add("\"");
    for (const unsigned char* c = (const unsigned char*)value; *c; ++c) {
      if (*c == '"' || *c == '\\') add("\\%c", *c);
      else if (*c < 32) add("\\u%04x", *c);
      else add("%c", *c);
    }
    add("\"");
  }
};
