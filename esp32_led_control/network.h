#pragma once
#include <WiFi.h>
#include <Preferences.h>
#include <esp_wifi.h>

// Provision over USB; all connection attempts run without blocking the LED loop.
class Network {
 public:
  char ssid[33] = {};
  char password[65] = {};
  const char* state = "unconfigured";
  const char* error = "";
  uint32_t since = 0;
  bool enabled = false;
  bool storageReady = false;
  bool scanning = false;
  uint32_t scanSince = 0;
  Preferences storage;

  static void printJsonString(const char* value) {
    for (const unsigned char* c = (const unsigned char*)value; *c; ++c) {
      if (*c == '"' || *c == '\\') Serial.printf("\\%c", *c);
      else if (*c < 32) Serial.printf("\\u%04x", *c);
      else Serial.printf("%c", *c);
    }
  }
  void pollScan(uint32_t now) {
    if (!scanning) return;
    const int count = WiFi.scanComplete();
    if (count == WIFI_SCAN_RUNNING && uint32_t(now - scanSince) < 15000) return;
    const char* scanError = count == WIFI_SCAN_RUNNING ? "timeout" : count < 0 ? "scan_failed" : "";
    if (count < 0) esp_wifi_scan_stop();
    // Bound serial output and choose the strongest APs before sending results.
    int strongest[20];
    int selected = 0;
    const int available = count < 256 ? count : 256; // Arduino scan getters use uint8_t indexes.
    for (int i = 0; i < available; ++i) {
      if (!WiFi.SSID(i).length()) continue;
      int position = 0;
      while (position < selected && WiFi.RSSI(strongest[position]) >= WiFi.RSSI(i)) ++position;
      if (position >= 20) continue;
      if (selected < 20) ++selected;
      for (int j = selected - 1; j > position; --j) strongest[j] = strongest[j - 1];
      strongest[position] = i;
    }
    Serial.printf("WIFI_SCAN {\"error\":\"%s\",\"truncated\":%s,\"networks\":[", scanError, count > selected ? "true" : "false");
    for (int i = 0; i < selected; ++i) {
      const int index = strongest[i];
      Serial.printf("%s{\"ssid\":\"", i ? "," : "");
      printJsonString(WiFi.SSID(index).c_str());
      Serial.printf("\",\"rssi\":%ld,\"secure\":%s}", (long)WiFi.RSSI(index), WiFi.encryptionType(index) == WIFI_AUTH_OPEN ? "false" : "true");
    }
    Serial.println("]}");
    WiFi.scanDelete();
    scanning = false;
    if (!enabled) WiFi.mode(WIFI_OFF);
  }

  static int hexDigit(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
  }
  static bool decode(const char* hex, char* out, size_t capacity, bool empty = false) {
    if (!hex) return false;
    if (empty && !strcmp(hex, "-")) { out[0] = 0; return true; }
    const size_t length = strlen(hex);
    if (!length || length % 2 || length / 2 >= capacity) return false;
    for (size_t i = 0; i < length; i += 2) {
      const int a = hexDigit(hex[i]), b = hexDigit(hex[i + 1]);
      if (a < 0 || b < 0 || !(a || b)) return false;
      out[i / 2] = char(a * 16 + b);
    }
    out[length / 2] = 0;
    return true;
  }
  static bool validPassword(const char* value) {
    const size_t length = strlen(value);
    if (!length) return true;
    if (length == 64) {
      for (size_t i = 0; i < length; ++i) if (hexDigit(value[i]) < 0) return false;
      return true;
    }
    if (length < 8 || length > 63) return false;
    for (size_t i = 0; i < length; ++i)
      if ((unsigned char)value[i] < 32 || (unsigned char)value[i] > 126) return false;
    return true;
  }
  void connect() {
    WiFi.disconnect(false, false);
    WiFi.mode(WIFI_STA);
    WiFi.begin(ssid, password);
    enabled = true;
    state = "connecting";
    error = "";
    since = millis();
  }
  void begin() {
    // Credentials are managed in our NVS namespace, not the Wi-Fi driver's flash.
    WiFi.persistent(false);
    WiFi.setAutoReconnect(false);
    storageReady = storage.begin("led-wifi", false);
    if (!storageReady) { error = "storage_failed"; return; }
    char encoded[196] = {};
    if (storage.getBytesLength("credentials") == sizeof(encoded)) {
      storage.getBytes("credentials", encoded, sizeof(encoded));
      encoded[sizeof(encoded) - 1] = 0;
      char* separator = strchr(encoded, ':');
      if (separator) {
        *separator = 0;
        if (decode(encoded, ssid, sizeof(ssid)) &&
            decode(separator + 1, password, sizeof(password), true) && validPassword(password)) {
          connect();
          return;
        }
      }
    }
    ssid[0] = password[0] = 0;
  }
  void tick(uint32_t now) {
    pollScan(now);
    if (!enabled) return;
    const auto status = WiFi.status();
    if (status == WL_CONNECTED) { state = "connected"; error = ""; return; }
    if (!strcmp(state, "connected")) {
      if (!scanning) WiFi.disconnect(false, false);
      state = "retry_wait";
      error = "connection_lost";
      since = now;
    } else if (!strcmp(state, "connecting")) {
      if (status == WL_CONNECT_FAILED || status == WL_NO_SSID_AVAIL || uint32_t(now - since) >= 15000) {
        error = status == WL_CONNECT_FAILED ? "connect_failed" : status == WL_NO_SSID_AVAIL ? "ssid_unavailable" : "timeout";
        WiFi.disconnect(false, false);
        state = "retry_wait";
        since = now;
      }
    } else if (!scanning && !strcmp(state, "retry_wait") && uint32_t(now - since) >= 30000) connect();
  }
  bool command(char* cursor) {
    char* action = strtok_r(nullptr, " \t", &cursor);
    char* first = strtok_r(nullptr, " \t", &cursor);
    char* second = strtok_r(nullptr, " \t", &cursor);
    char* extra = strtok_r(nullptr, " \t", &cursor);
    if (!action) return false;
    for (char* c = action; *c; ++c) *c = toupper((unsigned char)*c);
    if (scanning) { Serial.println("ERR Wi-Fi scan in progress"); return true; }
    if (!strcmp(action, "SCAN") && !first) {
      if (!strcmp(state, "connecting")) { Serial.println("ERR Wi-Fi is connecting; retry scan later"); return true; }
      WiFi.mode(WIFI_STA);
      const int result = WiFi.scanNetworks(true, false, false, 200);
      if (result == WIFI_SCAN_FAILED) {
        WiFi.scanDelete();
        if (!enabled) WiFi.mode(WIFI_OFF);
        Serial.println("ERR Wi-Fi scan failed to start");
        return true;
      }
      scanning = true;
      scanSince = millis();
      Serial.println("OK WIFI SCAN");
      return true;
    }
    if (!strcmp(action, "SET")) {
      char nextSsid[33] = {}, nextPassword[65] = {};
      if (extra || !decode(first, nextSsid, sizeof(nextSsid)) ||
          !decode(second, nextPassword, sizeof(nextPassword), true) || !validPassword(nextPassword)) return false;
      char encoded[196] = {};
      snprintf(encoded, sizeof(encoded), "%s:%s", first, second);
      if (!storageReady || storage.putBytes("credentials", encoded, sizeof(encoded)) != sizeof(encoded)) {
        Serial.println("ERR Wi-Fi storage failed");
        return true;
      }
      strcpy(ssid, nextSsid);
      strcpy(password, nextPassword);
      connect();
    } else if (!strcmp(action, "CONNECT") && !first) {
      if (!ssid[0]) { Serial.println("ERR Wi-Fi not configured"); return true; }
      connect();
    } else if (!strcmp(action, "OFF") && !first) {
      enabled = false;
      WiFi.disconnect(true, false);
      WiFi.mode(WIFI_OFF);
      state = "off";
      error = "";
    } else if (!strcmp(action, "CLEAR") && !first) {
      if (!storageReady || !storage.clear()) { Serial.println("ERR Wi-Fi storage failed"); return true; }
      enabled = false;
      WiFi.disconnect(true, false);
      WiFi.mode(WIFI_OFF);
      memset(ssid, 0, sizeof(ssid));
      memset(password, 0, sizeof(password));
      state = "unconfigured";
      error = "";
    } else return false;
    Serial.printf("OK WIFI %s\n", action);
    return true;
  }
  void report() {
    Serial.printf(",\"wifi\":{\"state\":\"%s\",\"ssid\":\"", state);
    // Escape arbitrary SSID bytes so quotes/control characters cannot corrupt STATUS.
    printJsonString(ssid);
    const bool live = !strcmp(state, "connected");
    Serial.printf("\",\"ip\":\"%s\",\"rssi\":%ld,\"error\":\"%s\",\"scan_supported\":true,\"scanning\":%s}",
                  live ? WiFi.localIP().toString().c_str() : "", live ? (long)WiFi.RSSI() : 0L, error, scanning ? "true" : "false");
  }
};

Network network;
