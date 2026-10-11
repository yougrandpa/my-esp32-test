#pragma once
#include <string>
#include <vector>
#define WIFI_OFF 0
#define WIFI_STA 1
#define WIFI_SCAN_RUNNING -1
#define WIFI_SCAN_FAILED -2
#define WIFI_AUTH_OPEN 0
#define WL_IDLE_STATUS 0
#define WL_NO_SSID_AVAIL 1
#define WL_CONNECTED 3
#define WL_CONNECT_FAILED 4
#define WL_DISCONNECTED 6
struct TestIP {
  std::string toString() { return "192.168.1.42"; }
};
struct TestWiFi {
  struct AccessPoint { std::string name; int signal; int auth; };
  std::vector<AccessPoint> accessPoints;
  int scanResult = WIFI_SCAN_FAILED, radioMode = WIFI_OFF, scans = 0;
  bool failScanStart = false;
  int currentStatus = WL_DISCONNECTED;
  int begins = 0;
  std::string ssid, password;
  bool driverPersistence = true, autoReconnect = true;
  void persistent(bool value) { driverPersistence = value; }
  void setAutoReconnect(bool value) { autoReconnect = value; }
  void mode(int value) { radioMode = value; }
  int scanNetworks(bool async, bool hidden, bool passive, uint32_t) {
    if (!async || hidden || passive || failScanStart) return WIFI_SCAN_FAILED;
    ++scans;
    scanResult = WIFI_SCAN_RUNNING;
    return scanResult;
  }
  int scanComplete() { return scanResult; }
  void scanDelete() { scanResult = WIFI_SCAN_FAILED; }
  std::string SSID(int index) { return accessPoints[index].name; }
  int RSSI(int index) { return accessPoints[index].signal; }
  int encryptionType(int index) { return accessPoints[index].auth; }
  void disconnect(bool, bool) { currentStatus = WL_DISCONNECTED; }
  void begin(const char* name, const char* secret) {
    ++begins; ssid = name; password = secret; currentStatus = WL_IDLE_STATUS;
  }
  int status() { return currentStatus; }
  int RSSI() { return -54; }
  TestIP localIP() { return {}; }
};
inline TestWiFi WiFi;
