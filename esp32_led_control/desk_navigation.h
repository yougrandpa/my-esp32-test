#pragma once
#include <stdint.h>

struct DeskPageView {
  int page = 1;
  bool automatic = true, buttonHold = false;
  uint32_t contentTime = 0, resumeIn = 0;
};

// Button navigation is transient: no flash writes and no legacy NVS migration.
// Unsigned elapsed times also keep the 30-second timeout correct across wrap.
class DeskNavigation {
 public:
  static constexpr uint32_t HOLD_MS = 30000, PAGE_MS = 8000;
  bool buttonOwned = false;
  int selected = 1;
  uint32_t lastPress = 0;
  DeskPageView view(int configured, uint32_t now) const {
    DeskPageView v;
    if (!buttonOwned) {
      v.automatic = configured == 0;
      v.page = configured ? configured : 1 + (now / PAGE_MS % 3);
      v.contentTime = now;
      return v;
    }
    const uint32_t elapsed = now - lastPress;
    if (elapsed < HOLD_MS) {
      v.page = selected; v.automatic = false; v.buttonHold = true;
      v.contentTime = elapsed; v.resumeIn = HOLD_MS - elapsed;
    } else {
      v.contentTime = elapsed - HOLD_MS;
      v.page = 1 + ((selected - 1 + v.contentTime / PAGE_MS % 3) % 3);
    }
    return v;
  }
  void press(int configured, uint32_t now) {
    selected = view(configured, now).page % 3 + 1;
    lastPress = now; buttonOwned = true;
  }
  void reset() { buttonOwned = false; }
};

class DeskButton {
 public:
  static constexpr uint32_t DEBOUNCE_MS = 35;
  bool raw = false, stable = false, armed = false;
  uint32_t changedAt = 0;
  void begin(bool pressed, uint32_t now) {
    raw = stable = pressed; changedAt = now; armed = !pressed;
  }
  bool sample(bool pressed, uint32_t now) {
    if (pressed != raw) { raw = pressed; changedAt = now; }
    if (raw == stable || uint32_t(now - changedAt) < DEBOUNCE_MS) return false;
    stable = raw;
    if (!stable) { armed = true; return false; }
    if (!armed) return false;
    armed = false;
    return true;
  }
};
