#pragma once
#include <cstdint>
#include <cstdarg>
#include <cstdio>
#include <deque>
#include <string>
using String = std::string;
#define OUTPUT 1
inline uint32_t testTime = 0;
inline int testDuty = -1;
inline uint32_t millis() { return testTime; }
inline void pinMode(int, int) {}
inline void analogWrite(int, int duty) { testDuty = duty; }
inline void delay(int) {}
struct TestSerial {
  std::deque<char> input;
  std::string output;
  void begin(int) {}
  int available() { return input.size(); }
  int read() { char c = input.front(); input.pop_front(); return c; }
  void println(const char* text) { output += std::string(text) + "\n"; }
  void printf(const char* format, ...) {
    char buffer[2048];
    va_list arguments;
    va_start(arguments, format);
    vsnprintf(buffer, sizeof(buffer), format, arguments);
    va_end(arguments);
    output += buffer;
  }
};
inline TestSerial Serial;
