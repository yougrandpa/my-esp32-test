#pragma once
#include "screen.h"
#ifndef DESK_NO_HARDWARE
#include <Wire.h>
#include <U8g2lib.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>
#include <mutex>
#include <time.h>
#include <sys/time.h>
#include <freertos/task.h>
#include "weather_ca.h"

#ifndef DISPLAY_SDA
#define DISPLAY_SDA 21
#endif
#ifndef DISPLAY_SCL
#define DISPLAY_SCL 22
#endif

class DeskRuntime {
 public:
  U8G2 screen;
  uint8_t pixels[1024] = {};
  ScreenConfig activeDisplay;
  bool displayInitialized = false, displayPresent = false;
  uint32_t lastProbe = 0;
  TaskHandle_t task = nullptr, displayTask = nullptr;
  std::mutex mutex;
  DeskConfig snapshot;
  DeskWeather result, displayWeather;
  double resultLat = 0, resultLon = 0;
  int resultOffset = 0;
  bool online = false, resultReady = false;
  uint32_t requestedRefresh = 0, lastPublish = 0;
  static bool sameLocation(const DeskConfig& a, const DeskConfig& b) {
    return a.latitude == b.latitude && a.longitude == b.longitude && a.offset == b.offset;
  }
  void begin() {
    screenStore.begin(esp_random());
    configTime(0, 0, "ntp.aliyun.com", "pool.ntp.org", "time.cloudflare.com");
    snapshot = desk.config;
    if (xTaskCreate([](void* p) { static_cast<DeskRuntime*>(p)->service(); }, "desk-weather", 14336, this, 1, &task) != pdPASS) {
      task = nullptr;
      snprintf(desk.weather.error, sizeof(desk.weather.error), "task_failed");
    }
    if (xTaskCreate([](void* p) { static_cast<DeskRuntime*>(p)->displayService(); }, "desk-oled", 6144, this, 1, &displayTask) != pdPASS) {
      desk.displayPresent = false;
      Serial.println("ERR OLED task could not start");
    }
  }
  bool setTime(uint32_t epoch) {
    timeval now{static_cast<time_t>(epoch), 0};
    if (settimeofday(&now, nullptr) != 0) return false;
    desk.epoch = epoch;
    return true;
  }
  void tick() {
    desk.displayPresent = screenStore.latest().present;
    const time_t now = time(nullptr);
    desk.epoch = now >= 1704067200 && now <= 4102444799LL ? uint32_t(now) : 0;
    if (uint32_t(millis() - lastPublish) < 100) return;
    lastPublish = millis();
    std::lock_guard<std::mutex> lock(mutex);
    if (!sameLocation(snapshot, desk.config)) desk.weather = DeskWeather{};
    snapshot = desk.config;
    online = network.enabled && WiFi.status() == WL_CONNECTED;
    requestedRefresh = desk.refresh;
    if (resultReady) {
      if (resultLat == snapshot.latitude && resultLon == snapshot.longitude && resultOffset == snapshot.offset) desk.weather = result;
      resultReady = false;
    }
    displayWeather = desk.weather;
  }
  static bool weatherNumber(JsonVariantConst value, float& output) {
    if (!value.is<float>() && !value.is<int>()) return false;
    output = value.as<float>();
    return isfinite(output) && output >= -100 && output <= 100;
  }
  bool fetchWeather(const DeskConfig& c, DeskWeather& weather) {
    WiFiClientSecure client;
    client.setCACert(WEATHER_CA);
    client.setHandshakeTimeout(8);
    HTTPClient http;
    http.setConnectTimeout(5000);
    http.setTimeout(5000);
    http.useHTTP10(true); // Parse a bounded, unchunked JSON body.
    char url[420];
    // Daily dates use the timezone at the selected coordinates.
    snprintf(url, sizeof(url), "https://api.open-meteo.com/v1/forecast?latitude=%.6f&longitude=%.6f&current=temperature_2m,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min&forecast_days=3&timezone=auto", c.latitude, c.longitude);
    if (!http.begin(client, url)) { snprintf(weather.error, sizeof(weather.error), "weather_connect"); return false; }
    const int code = http.GET();
    if (code != 200 || http.getSize() > 8192) {
      snprintf(weather.error, sizeof(weather.error), code == 200 ? "weather_size" : "weather_http");
      http.end(); return false;
    }
    // This service returns connection-delimited responses without Content-Length.
    // Bound memory and total read time, including a server that stalls mid-body.
    String body;
    body.reserve(1024);
    auto& stream = http.getStream();
    const uint32_t started = millis();
    bool failed = false;
    while (http.connected() || stream.available()) {
      const int available = stream.available();
      if (available) {
        char chunk[256];
        const size_t count = stream.readBytes(chunk, available < 256 ? available : 256);
        if (body.length() + count > 8192 || !body.concat(chunk, count)) { failed = true; break; }
      } else vTaskDelay(1);
      if (uint32_t(millis() - started) >= 8000) { failed = true; break; }
    }
    if (http.getSize() >= 0 && int(body.length()) != http.getSize()) failed = true;
    http.end();
    if (failed) { snprintf(weather.error, sizeof(weather.error), "weather_size"); return false; }
    StaticJsonDocument<3072> json;
    if (body.length() > 8192 || deserializeJson(json, body)) { snprintf(weather.error, sizeof(weather.error), "weather_json"); return false; }
    const auto current = json["current"].as<JsonObjectConst>();
    const auto daily = json["daily"].as<JsonObjectConst>();
    bool valid = weatherNumber(current["temperature_2m"], weather.temperature) && current["weather_code"].is<int>();
    weather.code = current["weather_code"] | -1;
    for (int i = 0; i < 3; ++i) {
      auto& day = weather.days[i];
      const char* date = daily["time"][i] | "";
      valid = valid && strlen(date) == 10 && daily["weather_code"][i].is<int>() && weatherNumber(daily["temperature_2m_min"][i], day.low) && weatherNumber(daily["temperature_2m_max"][i], day.high);
      snprintf(day.date, sizeof(day.date), "%s", date);
      day.code = daily["weather_code"][i] | -1;
    }
    valid = valid && weather.code >= 0 && weather.code <= 99;
    for (const auto& day : weather.days) valid = valid && day.code >= 0 && day.code <= 99 && day.low <= day.high;
    if (!valid) { snprintf(weather.error, sizeof(weather.error), "weather_data"); return false; }
    weather.valid = true;
    weather.updated = uint32_t(time(nullptr));
    weather.error[0] = 0;
    return true;
  }
  const char* condition(int code) {
    if (code == 0) return "晴";
    if (code <= 3) return "多云";
    if (code == 45 || code == 48) return "雾";
    if (code >= 95) return "雷雨";
    if ((code >= 71 && code <= 77) || code == 85 || code == 86) return "雪";
    if (code >= 51 && code <= 82) return "雨";
    return "未知";
  }
  void text(int x, int y, const char* value) {
    screen.setFont(u8g2_font_wqy12_t_gb2312);
    screen.drawUTF8(x, y, value);
  }
  // Wrap by glyph width without splitting a UTF-8 character. Long items scroll
  // through successive pairs of lines so every saved character remains visible.
  void itemText(const char* value, uint32_t now) {
    screen.setFont(u8g2_font_wqy12_t_gb2312);
    char lines[8][73] = {};
    int row = 0, pos = 0;
    for (const unsigned char* p = (const unsigned char*)value; *p && row < 8;) {
      int size = *p < 128 ? 1 : *p < 224 ? 2 : *p < 240 ? 3 : 4;
      char glyph[5] = {};
      memcpy(glyph, p, size);
      char test[73]; snprintf(test, sizeof(test), "%s%s", lines[row], glyph);
      if (screen.getUTF8Width(test) > 126 && pos) { ++row; pos = 0; if (row == 8) break; }
      memcpy(lines[row] + pos, glyph, size); pos += size; p += size;
    }
    const bool compact = activeDisplay.model == 1;
    const int groups = compact ? row + 1 : (row + 2) / 2;
    const int first = (now / 4000 % groups) * (compact ? 1 : 2);
    text(0, compact ? 30 : 32, lines[first]);
    if (!compact && first + 1 <= row) text(0, 47, lines[first + 1]);
  }
  void configureDisplay() {
    const auto c = screenStore.settings();
    if (displayInitialized && c.model == activeDisplay.model && c.address == activeDisplay.address) return;
    activeDisplay = c;
    auto* u = screen.getU8g2();
    if (c.model == 1) u8g2_Setup_ssd1306_i2c_128x32_univision_f(u, U8G2_R0, u8x8_byte_arduino_hw_i2c, u8x8_gpio_and_delay_arduino);
    else if (c.model == 2) u8g2_Setup_sh1106_i2c_128x64_noname_f(u, U8G2_R0, u8x8_byte_arduino_hw_i2c, u8x8_gpio_and_delay_arduino);
    else u8g2_Setup_ssd1306_i2c_128x64_noname_f(u, U8G2_R0, u8x8_byte_arduino_hw_i2c, u8x8_gpio_and_delay_arduino);
    u8x8_SetPin_HW_I2C(screen.getU8x8(), U8X8_PIN_NONE, DISPLAY_SCL, DISPLAY_SDA);
    u->tile_buf_ptr = pixels;
    screen.setI2CAddress(c.address * 2);
    screen.enableUTF8Print();
    displayInitialized = true; displayPresent = false;
    lastProbe = millis() - 5000;
  }
  void probeDisplay(uint32_t now) {
    if (uint32_t(now - lastProbe) < (displayPresent ? 1000u : 5000u)) return;
    lastProbe = now;
    Wire.beginTransmission(activeDisplay.address);
    const bool present = Wire.endTransmission() == 0;
    if (present && !displayPresent) screen.begin();
    displayPresent = present;
  }
  void render(const DeskConfig& c, const DeskWeather& w, bool live) {
    configureDisplay();
    const uint32_t now = millis();
    const time_t epoch = time(nullptr);
    const time_t local = epoch + c.offset * 60;
    tm parts{}; gmtime_r(&local, &parts);
    const bool clockReady = epoch >= 1704067200;
    int alarm = -1, active[DESK_TODOS], count = 0;
    for (int i = 0; i < DESK_TODOS; ++i) {
      const auto& t = c.todos[i];
      if (!t.text[0] || t.done) continue;
      active[count++] = i;
      if (clockReady && t.due && t.due <= epoch && !t.dismissed && (alarm < 0 || t.due < c.todos[alarm].due)) alarm = i;
    }
    const int page = deskPageAt(c, now);
    char line[100];
    screen.clearBuffer();
    if (activeDisplay.model == 1) {
      if (alarm >= 0) { text(0, 12, "到点提醒"); itemText(c.todos[alarm].text, now); }
      else if (page == 1) {
        if (clockReady) strftime(line, sizeof(line), "%H:%M:%S", &parts); else snprintf(line, sizeof(line), "--:--:--");
        text(0, 12, c.city); screen.setFont(u8g2_font_logisoso16_tn); screen.drawStr(0, 31, line);
      } else if (page == 2) {
        text(0, 12, c.city);
        if (!w.valid) text(0, 30, live ? "正在获取天气" : "请先连接 Wi-Fi");
        else {
          const int day = deskRotationAt(c, now, 8000, 3);
          if ((now / 4000) % 2 == 0) snprintf(line, sizeof(line), "%.1f°C %s", w.temperature, condition(w.code));
          else snprintf(line, sizeof(line), "%s %s %.0f~%.0f", w.days[day].date + 5, condition(w.days[day].code), w.days[day].low, w.days[day].high);
          text(0, 30, line);
        }
      } else {
        snprintf(line, sizeof(line), "待办 %d 项", count); text(0, 12, line);
        if (!count) text(0, 30, "今天没有未完成事项");
        else {
          const auto& t = c.todos[active[deskRotationAt(c, now, 12000, count)]];
          if (t.due && now / 4000 % 3 == 2) { time_t due = t.due + c.offset * 60; tm date{}; gmtime_r(&due, &date); strftime(line, sizeof(line), "%m-%d %H:%M", &date); text(0, 30, line); }
          else itemText(t.text, now);
        }
      }
    } else if (alarm >= 0) {
      text(0, 12, "到点提醒"); itemText(c.todos[alarm].text, now); text(0, 63, "请在网页确认或完成");
    } else if (page == 1) {
      text(0, 12, c.city);
      screen.setFont(u8g2_font_logisoso24_tn);
      if (clockReady) { strftime(line, sizeof(line), "%H:%M:%S", &parts); screen.drawStr(0, 43, line); }
      else screen.drawStr(0, 43, "--:--:--");
      if (clockReady) { strftime(line, sizeof(line), "%Y-%m-%d", &parts); text(0, 62, line); }
      else text(0, 62, "联网或通过网页校时");
    } else if (page == 2) {
      snprintf(line, sizeof(line), "%s %s", c.city, live ? "天气" : "离线"); text(0, 12, line);
      if (!w.valid) { text(0, 34, live ? "正在获取天气" : "请先连接 Wi-Fi"); if (w.error[0]) text(0, 52, "天气请求失败，稍后重试"); }
      else {
        snprintf(line, sizeof(line), "%.1f°C %s%s", w.temperature, condition(w.code), epoch - w.updated > 3600 || w.error[0] ? " 旧" : ""); text(0, 27, line);
        const int day = deskRotationAt(c, now, 8000, 3);
        snprintf(line, sizeof(line), "%s %s", w.days[day].date + 5, condition(w.days[day].code)); text(0, 44, line);
        snprintf(line, sizeof(line), "%.0f~%.0f°C", w.days[day].low, w.days[day].high); text(0, 62, line);
      }
    } else {
      snprintf(line, sizeof(line), "待办 %d 项", count); text(0, 12, line);
      if (!count) text(0, 37, "今天没有未完成事项");
      else {
        const auto& t = c.todos[active[deskRotationAt(c, now, 12000, count)]];
        itemText(t.text, c.page ? now : now % 8000);
        if (t.due) { time_t due = t.due + c.offset * 60; tm date{}; gmtime_r(&due, &date); strftime(line, sizeof(line), "%m-%d %H:%M", &date); text(0, 63, line); }
        else text(0, 63, "无定时提醒");
      }
    }
    probeDisplay(now);
    if (displayPresent) screen.sendBuffer();
    screenStore.publish(activeDisplay, screen.getBufferPtr(), now, alarm >= 0 ? 4 : page, displayPresent);
  }
  void displayService() {
    Wire.begin(DISPLAY_SDA, DISPLAY_SCL);
    Wire.setTimeOut(25);
    for (;;) {
      DeskConfig c; DeskWeather w; bool live;
      { std::lock_guard<std::mutex> lock(mutex); c = snapshot; w = displayWeather; live = online; }
      render(c, w, live);
      vTaskDelay(pdMS_TO_TICKS(250));
    }
  }
  void service() {
    DeskConfig previous;
    { std::lock_guard<std::mutex> lock(mutex); previous = snapshot; }
    DeskWeather cached;
    uint32_t lastFetch = 0, seenRefresh = 0;
    bool attempted = false;
    for (;;) {
      DeskConfig c; bool live; uint32_t refresh;
      { std::lock_guard<std::mutex> lock(mutex); c = snapshot; live = online; refresh = requestedRefresh; }
      const bool changed = !sameLocation(c, previous);
      if (changed) { cached = DeskWeather{}; attempted = false; previous = c; }
      const uint32_t elapsed = millis() - lastFetch;
      if (live && time(nullptr) >= 1704067200 && (!attempted || elapsed >= (cached.error[0] ? 300000u : 1800000u) || (refresh != seenRefresh && elapsed >= 30000))) {
        lastFetch = millis(); attempted = true; seenRefresh = refresh;
        DeskWeather fetched;
        if (fetchWeather(c, fetched)) cached = fetched;
        else snprintf(cached.error, sizeof(cached.error), "%s", fetched.error);
        { std::lock_guard<std::mutex> lock(mutex); result = cached; resultLat = c.latitude; resultLon = c.longitude; resultOffset = c.offset; resultReady = true; }
      }
      vTaskDelay(pdMS_TO_TICKS(250));
    }
  }
};
#else
class DeskRuntime {
 public:
  void begin() { screenStore.begin(); }
  void tick() {}
  bool setTime(uint32_t epoch) { desk.epoch = epoch; return true; }
};
#endif
DeskRuntime deskRuntime;

bool executeDeskCommand(char* line, char* reply, size_t capacity) {
  if (strchr(line, '\n') || strchr(line, '\r')) return false;
  char* cursor;
  char* command = strtok_r(line, " \t", &cursor);
  if (!command || strcasecmp(command, "DESK")) return false;
  // Manual browser synchronization is a fallback when NTP is unavailable.
  char copy[256]; snprintf(copy, sizeof(copy), "%s", cursor);
  char* timeCursor;
  char* op = strtok_r(copy, " \t", &timeCursor);
  if (op && !strcasecmp(op, "DISPLAY")) {
    if (!screenStore.command(timeCursor)) return false;
  } else if (op && !strcasecmp(op, "TIME")) {
    uint32_t epoch;
    char* arg = strtok_r(nullptr, " \t", &timeCursor);
    if (strtok_r(nullptr, " \t", &timeCursor) || !Desk::integer(arg, 1704067200u, 4102444799u, epoch) || !deskRuntime.setTime(epoch)) return false;
  } else if (!desk.command(cursor)) return false;
  snprintf(reply, capacity, "OK DESK");
  return true;
}
