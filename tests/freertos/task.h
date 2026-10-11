#pragma once
#include "FreeRTOS.h"
#include <chrono>
#include <thread>

// Host tests drive service() themselves, keeping Wi-Fi lifecycle deterministic.
inline int xTaskCreate(void (*)(void*), const char*, unsigned, void* context, unsigned, TaskHandle_t* handle) {
  *handle = context;
  return pdPASS;
}
inline void vTaskDelay(unsigned ticks) { std::this_thread::sleep_for(std::chrono::milliseconds(ticks)); }
