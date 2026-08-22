#include "tusb.h"

#include <stdio.h>

#include "esp_mac.h"

#define USB_VID 0x303a
#define USB_PID 0x4001
#define USB_BCD 0x0200

#define ITF_NUM_CCID 0
#define ITF_NUM_HID 1
// CDC instance 0 = helper channel (EV/PW). CDC instance 1 = config console.
// Two separate serial interfaces let the macOS helper and the browser each hold
// their own port, so they never contend for a single one.
#define ITF_NUM_CDC0 2
#define ITF_NUM_CDC0_DATA 3
#define ITF_NUM_CDC1 4
#define ITF_NUM_CDC1_DATA 5
#define ITF_NUM_TOTAL 6

#define EPNUM_CCID_OUT 0x01
#define EPNUM_CCID_IN 0x81
#define EPNUM_HID 0x82
#define EPNUM_CDC0_NOTIF 0x83
#define EPNUM_CDC0_OUT 0x04
#define EPNUM_CDC0_IN 0x84
#define EPNUM_CDC1_NOTIF 0x85
#define EPNUM_CDC1_OUT 0x06
#define EPNUM_CDC1_IN 0x86
#define CONFIG_TOTAL_LEN (TUD_CONFIG_DESC_LEN + 9 + 54 + 7 + 7 + TUD_HID_DESC_LEN + 2 * TUD_CDC_DESC_LEN)

uint8_t const tiny_touch_hid_report_descriptor[] = {
  TUD_HID_REPORT_DESC_KEYBOARD()
};

const tusb_desc_device_t tiny_touch_device_descriptor = {
  .bLength = sizeof(tusb_desc_device_t),
  .bDescriptorType = TUSB_DESC_DEVICE,
  .bcdUSB = USB_BCD,
  .bDeviceClass = 0x00,
  .bDeviceSubClass = 0x00,
  .bDeviceProtocol = 0x00,
  .bMaxPacketSize0 = CFG_TUD_ENDPOINT0_SIZE,
  .idVendor = USB_VID,
  .idProduct = USB_PID,
  .bcdDevice = 0x0100,
  .iManufacturer = 0x01,
  .iProduct = 0x02,
  .iSerialNumber = 0x03,
  .bNumConfigurations = 0x01,
};

const uint8_t tiny_touch_fs_configuration_descriptor[] = {
  TUD_CONFIG_DESCRIPTOR(1, ITF_NUM_TOTAL, 0, CONFIG_TOTAL_LEN, 0, 100),

  9, TUSB_DESC_INTERFACE, ITF_NUM_CCID, 0, 2, 0x0b, 0x00, 0x00, 0,

  54, 0x21,
  0x10, 0x01,
  0x00,
  0x07,
  0x02, 0x00, 0x00, 0x00,
  0x80, 0x25, 0x00, 0x00,
  0x80, 0x25, 0x00, 0x00,
  0x00,
  0x80, 0x25, 0x00, 0x00,
  0x80, 0x25, 0x00, 0x00,
  0x00,
  0xfe, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
  0x3e, 0x00, 0x02, 0x00,
  0x00, 0x08, 0x00, 0x00,
  0x00,
  0x00,
  0x00, 0x00,
  0x00,
  0x01,

  7, TUSB_DESC_ENDPOINT, EPNUM_CCID_OUT, TUSB_XFER_BULK, 64, 0x00, 0,
  7, TUSB_DESC_ENDPOINT, EPNUM_CCID_IN, TUSB_XFER_BULK, 64, 0x00, 0,
  TUD_HID_DESCRIPTOR(ITF_NUM_HID, 0, HID_ITF_PROTOCOL_KEYBOARD,
                     sizeof(tiny_touch_hid_report_descriptor), EPNUM_HID, 8, 10),

  TUD_CDC_DESCRIPTOR(ITF_NUM_CDC0, 4, EPNUM_CDC0_NOTIF, 8,
                     EPNUM_CDC0_OUT, EPNUM_CDC0_IN, 64),
  TUD_CDC_DESCRIPTOR(ITF_NUM_CDC1, 5, EPNUM_CDC1_NOTIF, 8,
                     EPNUM_CDC1_OUT, EPNUM_CDC1_IN, 64),
};

static char tiny_touch_serial[20] = "TT-PIV-PROTOTYPE";

char const *tiny_touch_string_descriptors[] = {
  (const char[]){0x09, 0x04},
  "tinyTouch",
  "tinyTouch",
  tiny_touch_serial,
  "tinyTouch helper",
  "tinyTouch config",
};

const int tiny_touch_string_descriptor_count =
  sizeof(tiny_touch_string_descriptors) / sizeof(tiny_touch_string_descriptors[0]);

void tiny_touch_init_serial(void) {
  uint8_t mac[6];
  if (esp_read_mac(mac, ESP_MAC_WIFI_STA) != ESP_OK) return;
  snprintf(tiny_touch_serial, sizeof(tiny_touch_serial), "TT-%02X%02X%02X%02X%02X%02X",
           mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
}
