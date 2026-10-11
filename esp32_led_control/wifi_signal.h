#pragma once

// ESP32 returns 0 when an AP signal reading is unavailable. Never turn that
// sentinel into a full-strength indicator. dBm is a measurement; bars are bins.
inline bool wifiSignalMeasured(bool connected, int rssi) {
  return connected && rssi >= -127 && rssi < 0;
}
inline int wifiSignalBars(bool connected, int rssi) {
  if (!wifiSignalMeasured(connected, rssi)) return 0;
  if (rssi >= -60) return 3;
  if (rssi >= -75) return 2;
  return 1;
}
