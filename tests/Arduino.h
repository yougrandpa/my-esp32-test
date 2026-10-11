#pragma once
#include <cstdint>
#include <cstdarg>
#include <cstdio>
#include <deque>
#include <string>
using String = std::string;
#define OUTPUT 1
#define INPUT_PULLUP 2
#define LOW 0
#define HIGH 1
inline uint32_t testTime = 0;
inline int testDuty = -1;
inline int testButtonLevel = HIGH, testInputPin = -1;
inline uint32_t millis() { return testTime; }
inline void pinMode(int pin, int mode) { if (mode == INPUT_PULLUP) testInputPin = pin; }
inline int digitalRead(int) { return testButtonLevel; }
inline void analogWrite(int, int duty) { testDuty = duty; }
inline void delay(int) {}
struct TestSerial {
  size_t setTxBufferSize(size_t size) { return size; }
  int availableForWrite() { return 8192; }
  std::deque<char> input;
  std::string output;
  void begin(int) {}
  int available() { return input.size(); }
  int read() { char c = input.front(); input.pop_front(); return c; }
  void println(const char* text) { output += std::string(text) + "\n"; }
  void printf(const char* format, ...) {
    char buffer[8192];
    va_list arguments;
    va_start(arguments, format);
    vsnprintf(buffer, sizeof(buffer), format, arguments);
    va_end(arguments);
    output += buffer;
  }
};
inline TestSerial Serial;
