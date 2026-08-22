#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

void piv_init(void);
void piv_reload_keys(void);
void piv_note_user_presence(void);
void piv_set_pairing_mode(bool enabled);
bool piv_pairing_mode_active(void);
bool piv_uses_provisioned_keys(void);
bool piv_pin_set(const char *pin);
bool piv_pin_get(char *out, size_t cap);
int piv_pin_retries_left(void);
bool piv_handle_apdu(const uint8_t *apdu, size_t apdu_len,
                     uint8_t *response, size_t *response_len,
                     size_t response_cap);
