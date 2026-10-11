#pragma once
#include <stdint.h>
#include <math.h>

enum Mode { MODE_OFF, MODE_ON, MODE_BLINK, MODE_BREATHE, MODE_SOS };

struct Effect {
  Mode mode = MODE_BLINK;
  int brightness = 255;
  uint32_t onMs = 500;
  uint32_t offMs = 500;
  uint32_t breatheMs = 3000;
  uint32_t sosUnitMs = 150;
};

// S: ...  O: ---  S: ... . Marks are 1/3 units, gaps 1/3/7 units.
static const uint8_t SOS_SEGMENTS[] = {1,1,1,1,1,3,3,1,3,1,3,3,1,1,1,1,1,7};
static const uint32_t SOS_UNITS = 34;

inline const char* modeName(Mode mode) {
  switch (mode) {
    case MODE_ON: return "on";
    case MODE_OFF: return "off";
    case MODE_BREATHE: return "breathe";
    case MODE_SOS: return "sos";
    default: return "blink";
  }
}

// elapsed is unsigned, so millis() rollover is safe for these short cycles.
inline int effectDuty(const Effect& effect, uint32_t elapsed) {
  switch (effect.mode) {
    case MODE_OFF: return 0;
    case MODE_ON: return effect.brightness;
    case MODE_BLINK:
      return elapsed % (effect.onMs + effect.offMs) < effect.onMs ? effect.brightness : 0;
    case MODE_BREATHE: {
      const float phase = float(elapsed % effect.breatheMs) / effect.breatheMs;
      return int(lroundf(effect.brightness * (0.5f - 0.5f * cosf(phase * 6.28318530718f))));
    }
    case MODE_SOS: {
      uint32_t position = elapsed % (SOS_UNITS * effect.sosUnitMs);
      for (unsigned i = 0; i < sizeof(SOS_SEGMENTS); ++i) {
        const uint32_t duration = SOS_SEGMENTS[i] * effect.sosUnitMs;
        if (position < duration) return i % 2 == 0 ? effect.brightness : 0;
        position -= duration;
      }
      return 0;
    }
  }
  return 0;
}
