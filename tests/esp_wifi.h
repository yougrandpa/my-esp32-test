#pragma once
#include "WiFi.h"
inline int esp_wifi_scan_stop() { WiFi.scanResult = WIFI_SCAN_FAILED; return 0; }
