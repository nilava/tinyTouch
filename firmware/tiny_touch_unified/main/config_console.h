#pragma once

void config_console_start(void);
void config_console_send_line(const char *line);
void config_console_duress_wipe(void);

#include <stddef.h>
#include <stdint.h>
void config_hid_on_command(const uint8_t *data, size_t len);
size_t config_hid_read_response(uint8_t *out, size_t cap);
