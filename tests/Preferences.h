#pragma once
#include <map>
#include <string>
#include <vector>
#include <cstring>
struct Preferences {
  inline static std::map<std::string, std::vector<char>> values;
  inline static bool failWrites = false;
  std::string prefix;
  bool begin(const char* name, bool) { prefix = std::string(name) + ":"; return true; }
  size_t getBytesLength(const char* key) { return values[prefix + key].size(); }
  size_t getBytes(const char* key, void* output, size_t size) {
    const auto& data = values[prefix + key];
    if (data.size() != size) return 0;
    memcpy(output, data.data(), size);
    return size;
  }
  size_t putBytes(const char* key, const void* value, size_t size) {
    if (failWrites) return 0;
    const auto* bytes = (const char*)value;
    values[prefix + key] = std::vector<char>(bytes, bytes + size);
    return size;
  }
  bool clear() {
    if (failWrites) return false;
    for (auto it = values.begin(); it != values.end();) {
      if (it->first.compare(0, prefix.size(), prefix) == 0) it = values.erase(it);
      else ++it;
    }
    return true;
  }
};
