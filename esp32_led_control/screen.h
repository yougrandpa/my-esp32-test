#pragma once
#include "desk.h"
#include <mutex>

struct ScreenModel { const char* id; uint16_t width, height; };
constexpr ScreenModel SCREEN_MODELS[] = {
  {"ssd1306-128x64", 128, 64}, {"ssd1306-128x32", 128, 32}, {"sh1106-128x64", 128, 64}
};
struct ScreenConfig { uint32_t version = 1; uint8_t model = 0, address = 0x3c; };
struct ScreenFrame {
  ScreenConfig config;
  uint32_t boot = 1, sequence = 0, uptime = 0, checksum = 0;
  int page = 1;
  bool present = false;
  uint8_t pixels[1024] = {};
};
inline uint32_t screenChecksum(const uint8_t* bytes, size_t size) {
  uint32_t hash = 2166136261u;
  for (size_t i = 0; i < size; ++i) hash = (hash ^ bytes[i]) * 16777619u;
  return hash;
}
// One complete frame is published at a time. Never hold this lock during I2C,
// serial or HTTP I/O. Configuration is separate from legacy desk/todo storage.
class ScreenStore {
 public:
  std::mutex mutex;
  Preferences storage;
  bool storageReady = false;
  ScreenConfig config;
  ScreenFrame frame;
  uint32_t boot = 1;
  void begin(uint32_t bootId = 1) {
    boot = bootId ? bootId : 1;
    storageReady = storage.begin("led-screen", false);
    ScreenConfig saved;
    if (storageReady && storage.getBytesLength("config") == sizeof(saved) && storage.getBytes("config", &saved, sizeof(saved)) == sizeof(saved) && valid(saved)) config = saved;
  }
  static bool valid(const ScreenConfig& c) { return c.version == 1 && c.model < 3 && (c.address == 0x3c || c.address == 0x3d); }
  ScreenConfig settings() { std::lock_guard<std::mutex> lock(mutex); return config; }
  ScreenFrame latest() { std::lock_guard<std::mutex> lock(mutex); return frame; }
  bool command(char* args) {
    char* cursor;
    char* model = strtok_r(args, " \t", &cursor);
    char* address = strtok_r(nullptr, " \t", &cursor);
    uint32_t value;
    if (!model || strtok_r(nullptr, " \t", &cursor) || !Desk::integer(address, 60, 61, value)) return false;
    ScreenConfig next; next.model = 3; next.address = value;
    for (uint8_t i = 0; i < 3; ++i) if (!strcmp(model, SCREEN_MODELS[i].id)) next.model = i;
    if (!valid(next) || !storageReady || storage.putBytes("config", &next, sizeof(next)) != sizeof(next)) return false;
    std::lock_guard<std::mutex> lock(mutex); config = next;
    return true;
  }
  void publish(const ScreenConfig& c, const uint8_t* pixels, uint32_t now, int page, bool present) {
    std::lock_guard<std::mutex> lock(mutex);
    frame.config = c; frame.boot = boot; ++frame.sequence; frame.uptime = now; frame.page = page; frame.present = present;
    const size_t size = SCREEN_MODELS[c.model].width * SCREEN_MODELS[c.model].height / 8;
    memcpy(frame.pixels, pixels, size); frame.checksum = screenChecksum(pixels, size);
  }
  void appendStatus(StatusJsonBuffer& json) {
    const auto c = settings();
    json.add(",\"display\":{\"model\":\"%s\",\"width\":%u,\"height\":%u,\"address\":%u}", SCREEN_MODELS[c.model].id, SCREEN_MODELS[c.model].width, SCREEN_MODELS[c.model].height, c.address);
  }
  bool format(char* output, size_t capacity) {
    const auto f = latest();
    const auto& model = SCREEN_MODELS[f.config.model];
    StatusJsonBuffer json(output, capacity);
    if (!f.sequence) { json.add("{\"error\":\"screen_not_ready\"}"); return false; }
    json.add("{\"version\":1,\"model\":\"%s\",\"width\":%u,\"height\":%u,\"address\":%u,\"packing\":\"page-lsb\",\"boot_id\":%lu,\"sequence\":%lu,\"uptime_ms\":%lu,\"page\":%d,\"present\":%s,\"checksum\":%lu,\"pixels\":\"", model.id, model.width, model.height, f.config.address, (unsigned long)f.boot, (unsigned long)f.sequence, (unsigned long)f.uptime, f.page, f.present ? "true" : "false", (unsigned long)f.checksum);
    for (size_t i = 0; i < model.width * model.height / 8; ++i) json.add("%02x", f.pixels[i]);
    json.add("\"}"); return json.valid;
  }
};
ScreenStore screenStore;
