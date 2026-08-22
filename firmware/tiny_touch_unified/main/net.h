#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// Optional Wi-Fi / MQTT / SNTP support. Everything is runtime-gated on NVS
// configuration: with no SSID stored the radio never comes up, so a device that
// is never configured behaves exactly like the wired-only firmware.
//
// The MQTT path is deliberately publish-only. Nothing this device receives over
// the network can trigger an authentication, change configuration, or type a
// key. It is a one-way presence beacon, not a remote control surface.

void net_init(void);
void net_reload(void);

// Persist Wi-Fi credentials (empty ssid clears them and stops the radio on the
// next reload). Returns false on NVS error or oversized input.
bool net_set_wifi(const char *ssid, const char *password);

// Persist the MQTT broker URI (e.g. "mqtt://192.168.1.10:1883") and optional
// topic prefix. Empty uri disables MQTT.
bool net_set_mqtt(const char *uri, const char *topic_prefix);

// Publish a fingerprint event {slot, result, ts} under <prefix>/event. No-op if
// MQTT is unconfigured or disconnected. Never blocks the caller.
void net_publish_event(uint16_t slot, bool success);

// One-line status for the console STATUS command.
void net_status(char *out, size_t cap);

// True once SNTP has set a plausible wall-clock time (for TOTP / timestamps).
bool net_time_valid(void);
