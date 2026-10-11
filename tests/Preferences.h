#pragma once
#include <map>
#include <string>
#include <vector>
#include <cstring>
struct Preferences {
  inline static std::map<std::string, std::vector<char>> values;
  inline static bool failWrites = false;
  bool begin(const char*, bool) { return true; }
  size_t getBytesLength(const char* key) { return values[key].size(); }
  size_t getBytes(const char* key, void* output, size_t size) {
    const auto& data = values[key];
    if (data.size() != size) return 0;
    memcpy(output, data.data(), size);
    return size;
  }
  size_t putBytes(const char* key, const void* value, size_t size) {
    if (failWrites) return 0;
    const auto* bytes = (const char*)value;
    values[key] = std::vector<char>(bytes, bytes + size);
    return size;
  }
  bool clear() {
    if (failWrites) return false;
    values.clear();
    return true;
  }
};
