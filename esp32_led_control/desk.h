#pragma once
#include <Preferences.h>
#include <math.h>
#include <ctype.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include "json_buffer.h"

constexpr int DESK_TODOS = 6;
struct DeskTodo { char text[73] = {}; uint32_t due = 0; bool done = false, dismissed = false; };
struct DeskConfig {
  uint32_t version = 1;
  double latitude = 28.2282, longitude = 112.9388;
  int offset = 480; // Minutes east of UTC; China has no daylight saving time.
  char city[49] = "长沙";
  int page = 0; // auto, clock, weather, todo
  DeskTodo todos[DESK_TODOS];
};
inline int deskPageAt(const DeskConfig& c, uint32_t now) {
  return c.page ? c.page : 1 + (now / 8000 % 3);
}
inline int deskRotationAt(const DeskConfig& c, uint32_t now, uint32_t dwell, int count) {
  // Automatic pages are only visible once each cycle. Advance their content
  // once per full cycle, rather than skipping items during hidden intervals.
  return count > 0 ? (c.page ? now / dwell : now / 24000) % count : 0;
}
struct DeskForecast { char date[11] = {}; int code = 0; float low = 0, high = 0; };
struct DeskWeather {
  bool valid = false;
  uint32_t updated = 0;
  float temperature = 0;
  int code = 0;
  char error[32] = {};
  DeskForecast days[3];
};

class Desk {
 public:
  DeskConfig config;
  DeskWeather weather;
  Preferences storage;
  bool storageReady = false, displayPresent = false;
  uint32_t epoch = 0, revision = 1, refresh = 0;
  static bool number(const char* s, double low, double high, double& out) {
    if (!s || !*s) return false;
    char* end;
    out = strtod(s, &end);
    return !*end && isfinite(out) && out >= low && out <= high;
  }
  static bool integer(const char* s, uint32_t low, uint32_t high, uint32_t& out) {
    double value;
    if (!number(s, low, high, value) || floor(value) != value) return false;
    out = uint32_t(value);
    return true;
  }
  // Reject controls, malformed UTF-8 and unterminated stored strings.
  static bool textValid(const char* s, size_t capacity) {
    size_t i = 0;
    while (i < capacity && s[i]) {
      const unsigned char c = s[i++];
      if (c < 32 || c == 127) return false;
      if (c < 128) continue;
      int n = c >= 0xc2 && c <= 0xdf ? 1 : c >= 0xe0 && c <= 0xef ? 2 : c >= 0xf0 && c <= 0xf4 ? 3 : -1;
      if (n < 0 || i + n >= capacity) return false;
      const unsigned char first = s[i];
      if ((c == 0xe0 && first < 0xa0) || (c == 0xed && first >= 0xa0) || (c == 0xf0 && first < 0x90) || (c == 0xf4 && first >= 0x90)) return false;
      while (n--) if ((static_cast<unsigned char>(s[i++]) & 0xc0) != 0x80) return false;
    }
    return i < capacity;
  }
  static bool decode(const char* hex, char* out, size_t capacity) {
    if (!hex || !strlen(hex) || strlen(hex) % 2 || strlen(hex) / 2 >= capacity) return false;
    auto digit = [](char c) { return c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1; };
    const size_t size = strlen(hex) / 2;
    for (size_t i = 0; i < size; ++i) {
      int a = digit(hex[2*i]), b = digit(hex[2*i+1]);
      if (a < 0 || b < 0 || !(a || b)) return false;
      out[i] = char(a*16+b);
    }
    out[size] = 0;
    return textValid(out, capacity);
  }
  static bool valid(const DeskConfig& c) {
    if (c.version != 1 || !isfinite(c.latitude) || !isfinite(c.longitude) || fabs(c.latitude) > 90 || fabs(c.longitude) > 180 || c.offset < -720 || c.offset > 840 || c.page < 0 || c.page > 3 || !c.city[0] || !textValid(c.city, sizeof(c.city))) return false;
    for (const auto& todo : c.todos) if (!textValid(todo.text, sizeof(todo.text)) || (todo.due && (todo.due < 1704067200u || todo.due > 4102444799u))) return false;
    return true;
  }
  void begin() {
    storageReady = storage.begin("led-desk", false);
    DeskConfig saved;
    if (storageReady && storage.getBytesLength("config") == sizeof(saved) && storage.getBytes("config", &saved, sizeof(saved)) == sizeof(saved) && valid(saved)) config = saved;
  }
  bool save(const DeskConfig& next) {
    if (!valid(next) || !storageReady || storage.putBytes("config", &next, sizeof(next)) != sizeof(next)) return false;
    config = next;
    ++revision;
    return true;
  }
  int alarm() const {
    if (epoch < 1704067200u) return -1;
    int selected = -1;
    for (int i = 0; i < DESK_TODOS; ++i) {
      const auto& t = config.todos[i];
      if (t.text[0] && t.due && t.due <= epoch && !t.done && !t.dismissed && (selected < 0 || t.due < config.todos[selected].due)) selected = i;
    }
    return selected;
  }
  // TIME is handled by the runtime; other commands are atomic NVS transactions.
  bool command(char* arguments) {
    char* cursor;
    char* op = strtok_r(arguments, " \t", &cursor);
    if (!op) return false;
    for (char* p = op; *p; ++p) *p = toupper((unsigned char)*p);
    char* a = strtok_r(nullptr, " \t", &cursor);
    char* b = strtok_r(nullptr, " \t", &cursor);
    char* c = strtok_r(nullptr, " \t", &cursor);
    char* d = strtok_r(nullptr, " \t", &cursor);
    if (strtok_r(nullptr, " \t", &cursor)) return false;
    DeskConfig next = config;
    uint32_t slot, due, done;
    if (!strcmp(op, "LOCATION")) {
      double offset;
      if (!number(a, -90, 90, next.latitude) || !number(b, -180, 180, next.longitude) || !number(c, -720, 840, offset) || floor(offset) != offset || !decode(d, next.city, sizeof(next.city))) return false;
      next.offset = int(offset);
    } else if (!strcmp(op, "TODO") && !d) {
      if (!integer(a, 0, DESK_TODOS-1, slot) || !integer(b, 0, 4102444799u, due) || (due && due < 1704067200u)) return false;
      next.todos[slot] = DeskTodo{};
      if (!decode(c, next.todos[slot].text, sizeof(next.todos[slot].text))) return false;
      next.todos[slot].due = due;
    } else if (!strcmp(op, "DONE") && !c) {
      if (!integer(a, 0, DESK_TODOS-1, slot) || !integer(b, 0, 1, done) || !next.todos[slot].text[0]) return false;
      next.todos[slot].done = done;
      if (!done) next.todos[slot].dismissed = false;
    } else if ((!strcmp(op, "DELETE") || !strcmp(op, "DISMISS")) && !b) {
      if (!integer(a, 0, DESK_TODOS-1, slot) || !next.todos[slot].text[0]) return false;
      if (!strcmp(op, "DELETE")) next.todos[slot] = DeskTodo{};
      else next.todos[slot].dismissed = true;
    } else if (!strcmp(op, "PAGE") && !b) {
      if (!integer(a, 0, 3, slot)) return false;
      next.page = slot;
    } else if (!strcmp(op, "REFRESH") && !a) { ++refresh; return true; }
    else return false;
    return save(next);
  }
  void appendStatus(StatusJsonBuffer& json) const {
    json.add(",\"desk\":{\"supported\":true,\"display_present\":%s,\"epoch\":%lu,\"offset\":%d,\"page\":%d,\"alarm\":%d,\"city\":", displayPresent ? "true" : "false", (unsigned long)epoch, config.offset, config.page, alarm());
    json.string(config.city);
    json.add(",\"latitude\":%.6f,\"longitude\":%.6f,\"weather\":{\"valid\":%s,\"updated\":%lu,\"temperature\":%.1f,\"code\":%d,\"error\":", config.latitude, config.longitude, weather.valid ? "true" : "false", (unsigned long)weather.updated, weather.temperature, weather.code);
    json.string(weather.error);
    json.add(",\"days\":[");
    for (int i = 0; i < 3; ++i) {
      const auto& day = weather.days[i];
      json.add("%s{\"date\":", i ? "," : ""); json.string(day.date);
      json.add(",\"code\":%d,\"low\":%.1f,\"high\":%.1f}", day.code, day.low, day.high);
    }
    json.add("]},\"todos\":[");
    for (int i = 0; i < DESK_TODOS; ++i) {
      const auto& t = config.todos[i];
      json.add("%s{\"text\":", i ? "," : ""); json.string(t.text);
      json.add(",\"due\":%lu,\"done\":%s,\"dismissed\":%s}", (unsigned long)t.due, t.done ? "true" : "false", t.dismissed ? "true" : "false");
    }
    json.add("]}");
  }
};
Desk desk;
