#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// Optional BLE HID keyboard. When enabled and bonded to a host (iPad/phone/TV),
// a fingerprint match on the configured slot types a stored credential to that
// host over Bluetooth instead of over USB. Runtime-gated on NVS config: if BLE
// is disabled the controller never starts.

void ble_hid_init(void);
bool ble_hid_enabled(void);
bool ble_hid_connected(void);

// Config (persisted in NVS).
bool ble_hid_set_enabled(bool enabled);
bool ble_hid_set_slot(uint8_t slot);        // 0 = disabled
uint8_t ble_hid_slot(void);
bool ble_hid_set_text(const char *text);    // credential to type

// Type the stored credential to the bonded host. No-op if not connected.
bool ble_hid_type_credential(void);
bool ble_hid_start_pairing(void);  // (re)start advertising for pairing

void ble_hid_status(char *out, size_t cap);
