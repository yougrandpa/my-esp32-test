#pragma once
#include <atomic>
#include <mutex>
#include <Preferences.h>
#include <freertos/task.h>
#ifndef DESK_NO_HARDWARE
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>
#include "weather_ca.h"
#endif

bool formatStatus(char*, size_t);
bool executeControlCommand(char*, char*, size_t);
struct CloudConfig { uint32_t version = 1; char url[129] = {}, token[65] = {}; };

class CloudControl {
 public:
  CloudConfig config;
  Preferences storage;
  std::mutex mutex;
  bool storageReady = false, enabled = false;
  uint32_t lastSuccess = 0;
  bool hasSuccess = false;
  char error[24] = {};
  std::atomic<uint32_t> revision{1};
  TaskHandle_t task = nullptr;
  enum class Exchange { idle, pending, ready };
  std::atomic<Exchange> exchange{Exchange::idle};
  uint32_t requestRevision = 0, receivedAt = 0, ttl = 0;
  char requestId[37] = {}, requestCommand[256] = {}, status[4096] = {};
  char lastId[37] = {}, lastReply[64] = {};
  bool lastOk = false;
#ifndef DESK_NO_HARDWARE
  // Owned exclusively by the cloud worker. Large wire buffers must not live on
  // its task stack: frame formatting and newlib printf need additional stack.
  char payload[8192], frame[2560];
#endif

  static bool validToken(const char* token) {
    const size_t length = strlen(token);
    if (length < 16 || length > 64) return false;
    for (const char* p = token; *p; ++p) if (!isalnum((unsigned char)*p) && *p != '-' && *p != '_') return false;
    return true;
  }
  static bool validUrl(const char* url) {
    const char* host = nullptr;
    if (!strncmp(url, "http://", 7)) host = url + 7;
    else if (!strncmp(url, "https://", 8)) host = url + 8;
    if (!host || !*host || strlen(url) > 128) return false;
    const char* p = host;
    while (*p && (isalnum((unsigned char)*p) || *p == '.' || *p == '-')) ++p;
    if (p == host) return false;
    if (*p == ':') {
      const char* port = ++p;
      unsigned value = 0;
      while (isdigit((unsigned char)*p)) { value = value * 10 + (*p++ - '0'); if (value > 65535) return false; }
      if (p == port || !value) return false;
    }
    return !*p || (*p == '/' && !p[1]);
  }
  static bool validId(const char* id) {
    if (!id || strlen(id) != 36) return false;
    for (int i = 0; i < 36; ++i) {
      if (i == 8 || i == 13 || i == 18 || i == 23) { if (id[i] != '-') return false; }
      else if (!isxdigit((unsigned char)id[i])) return false;
    }
    return true;
  }
  static bool valid(const CloudConfig& c) {
    return c.version == 1 && memchr(c.url, 0, sizeof(c.url)) && memchr(c.token, 0, sizeof(c.token)) && validUrl(c.url) && validToken(c.token);
  }
  void begin() {
    storageReady = storage.begin("led-cloud", false);
    CloudConfig saved;
    if (storageReady && storage.getBytesLength("config") == sizeof(saved) && storage.getBytes("config", &saved, sizeof(saved)) == sizeof(saved) && valid(saved)) { config = saved; enabled = true; }
#ifndef DESK_NO_HARDWARE
    if (xTaskCreate([](void* p) { static_cast<CloudControl*>(p)->service(); }, "led-cloud", 16384, this, 1, &task) != pdPASS) { task = nullptr; snprintf(error, sizeof(error), "task_failed"); }
#endif
  }
  bool command(char* args) {
    char* cursor;
    char* operation = strtok_r(args, " \t", &cursor);
    char* url = strtok_r(nullptr, " \t", &cursor);
    char* token = strtok_r(nullptr, " \t", &cursor);
    if (!operation || strtok_r(nullptr, " \t", &cursor)) return false;
    if (!strcasecmp(operation, "SET")) {
      if (!url || !token || !validUrl(url) || !validToken(token)) return false;
      CloudConfig next;
      snprintf(next.url, sizeof(next.url), "%s", url); snprintf(next.token, sizeof(next.token), "%s", token);
      if (!storageReady || storage.putBytes("config", &next, sizeof(next)) != sizeof(next)) return false;
      std::lock_guard<std::mutex> lock(mutex); config = next; enabled = true;
    } else {
      if (url || token) return false;
      if (!strcasecmp(operation, "CLEAR")) {
        if (!storageReady || !storage.clear()) return false;
        std::lock_guard<std::mutex> lock(mutex); config = CloudConfig{}; enabled = false;
      } else if (!strcasecmp(operation, "OFF")) { std::lock_guard<std::mutex> lock(mutex); enabled = false; }
      else if (!strcasecmp(operation, "CONNECT")) { std::lock_guard<std::mutex> lock(mutex); if (!valid(config)) return false; enabled = true; }
      else return false;
    }
    { std::lock_guard<std::mutex> lock(mutex); ++revision; hasSuccess = false; error[0] = 0; }
    Serial.printf("OK CLOUD %s\n", !strcasecmp(operation, "SET") ? "SET" : !strcasecmp(operation, "OFF") ? "OFF" : !strcasecmp(operation, "CLEAR") ? "CLEAR" : "CONNECT");
    return true;
  }
  void appendStatus(StatusJsonBuffer& json) {
    std::lock_guard<std::mutex> lock(mutex);
    const bool wifi = network.enabled && WiFi.status() == WL_CONNECTED;
    const char* state = !config.url[0] ? "unconfigured" : !enabled ? "off" : !wifi ? "waiting_wifi" : hasSuccess && uint32_t(millis() - lastSuccess) < 6500 ? "connected" : error[0] ? "error" : "connecting";
    json.add(",\"cloud\":{\"supported\":true,\"state\":\"%s\",\"url\":", state); json.string(config.url);
    json.add(",\"error\":"); json.string(error); json.add("}");
  }
  // Main-loop only. Cache the last acknowledgement so redelivery after a lost
  // network response never repeats a TODO write or restarts a light effect.
  void applyRemote() {
    if (!requestId[0] || !validId(requestId) || !strcmp(requestId, lastId)) return;
    snprintf(lastId, sizeof(lastId), "%s", requestId);
    lastOk = false;
    if (!ttl || uint32_t(millis() - receivedAt) >= ttl) { snprintf(lastReply, sizeof(lastReply), "ERR command expired"); return; }
    lastOk = executeControlCommand(requestCommand, lastReply, sizeof(lastReply));
    if (!lastOk) snprintf(lastReply, sizeof(lastReply), "ERR invalid control command");
  }
  void tick() {
    if (exchange.load(std::memory_order_acquire) != Exchange::pending) return;
    if (requestRevision == revision.load()) {
      applyRemote();
      if (!formatStatus(status, sizeof(status))) status[0] = 0;
    } else status[0] = 0;
    exchange.store(Exchange::ready, std::memory_order_release);
  }
#ifndef DESK_NO_HARDWARE
  void record(uint32_t generation, const char* reason) {
    std::lock_guard<std::mutex> lock(mutex);
    if (generation != revision.load()) return;
    snprintf(error, sizeof(error), "%s", reason);
    if (!*reason) { lastSuccess = millis(); hasSuccess = true; }
    else hasSuccess = false;
  }
  bool snapshot(uint32_t generation, const char* id = "", const char* command = "", uint32_t validFor = 0) {
    requestRevision = generation;
    snprintf(requestId, sizeof(requestId), "%s", id); snprintf(requestCommand, sizeof(requestCommand), "%s", command);
    receivedAt = millis(); ttl = validFor;
    exchange.store(Exchange::pending, std::memory_order_release);
    while (exchange.load(std::memory_order_acquire) != Exchange::ready) vTaskDelay(1);
    exchange.store(Exchange::idle, std::memory_order_release);
    return status[0] && generation == revision.load();
  }
  bool sync(const CloudConfig& c, uint32_t generation, char* response, size_t capacity) {
    StatusJsonBuffer json(payload, sizeof(payload));
    json.add("{\"boot_id\":%lu,\"status\":%s,\"frame\":", (unsigned long)screenStore.boot, status);
    const bool ready = screenStore.format(frame, sizeof(frame)); json.add("%s", ready ? frame : "null");
    json.add(",\"ack\":");
    if (*lastId) { json.add("{\"id\":"); json.string(lastId); json.add(",\"ok\":%s,\"reply\":", lastOk ? "true" : "false"); json.string(lastReply); json.add("}"); }
    else json.add("null");
    json.add("}"); if (!json.valid) { record(generation, "payload_size"); return false; }
    const bool tls = !strncmp(c.url, "https://", 8);
    if (tls && time(nullptr) < 1704067200) { record(generation, "time_not_ready"); return false; }
    WiFiClient plain; WiFiClientSecure secure;
    secure.setCACert(WEATHER_CA); secure.setHandshakeTimeout(5);
    HTTPClient http;
    http.setConnectTimeout(3000); http.setTimeout(3000); http.useHTTP10(true);
    char url[160]; snprintf(url, sizeof(url), "%s%sapi/device/sync", c.url, c.url[strlen(c.url)-1] == '/' ? "" : "/");
    if (!http.begin(tls ? static_cast<WiFiClient&>(secure) : plain, url)) { record(generation, "connect_failed"); return false; }
    char auth[80]; snprintf(auth, sizeof(auth), "Bearer %s", c.token);
    http.addHeader("Authorization", auth); http.addHeader("Content-Type", "application/json");
    const int code = http.POST((uint8_t*)payload, json.length);
    if (code != 200 || http.getSize() >= int(capacity)) {
      record(generation, code == 401 ? "unauthorized" : code == 404 ? "server_mode" : code == 409 ? "session_conflict" : code == 200 ? "response_size" : "server_unreachable"); http.end(); return false;
    }
    size_t length = 0; const uint32_t started = millis();
    auto& stream = http.getStream();
    while (http.connected() || stream.available()) {
      if (stream.available()) {
        const int value = stream.read();
        if (value >= 0) { if (length + 1 >= capacity) { record(generation, "response_size"); http.end(); return false; } response[length++] = char(value); }
      } else vTaskDelay(1);
      if (uint32_t(millis() - started) >= 3000) { record(generation, "server_timeout"); http.end(); return false; }
      if (http.getSize() >= 0 && length == size_t(http.getSize())) break;
    }
    response[length] = 0; http.end();
    return generation == revision.load();
  }
  void service() {
    uint32_t nextAttempt = 0, previousGeneration = 0;
    for (;;) {
      CloudConfig c; bool active; uint32_t generation;
      { std::lock_guard<std::mutex> lock(mutex); c = config; active = enabled; generation = revision.load(); }
      if (generation != previousGeneration || !active || WiFi.status() != WL_CONNECTED) { previousGeneration = generation; nextAttempt = millis(); }
      if (active && WiFi.status() == WL_CONNECTED && int32_t(millis() - nextAttempt) >= 0) {
        nextAttempt = millis() + 3000;
        if (snapshot(generation)) {
          char response[1024]; const uint32_t started = millis();
          if (sync(c, generation, response, sizeof(response))) {
            StaticJsonDocument<1024> json;
            if (deserializeJson(json, response) || json["ok"] != true) record(generation, "response_invalid");
            else {
              record(generation, "");
              const char* id = json["command"]["id"] | "";
              const char* command = json["command"]["command"] | "";
              const uint32_t validFor = json["command"]["ttl_ms"] | 0u;
              const uint32_t elapsed = uint32_t(millis() - started);
              if (*id && validId(id) && strlen(command) < sizeof(requestCommand) && validFor <= 4500) snapshot(generation, id, command, validFor > elapsed ? validFor - elapsed : 0);
              nextAttempt = millis() + (*id ? 50 : 1000);
            }
          }
        }
      }
      vTaskDelay(pdMS_TO_TICKS(25));
    }
  }
#endif
};
CloudControl cloudControl;
