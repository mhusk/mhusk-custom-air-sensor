"""USB-aware filesystem mount for Adafruit Feather ESP32-S3 (CircuitPython).

Why this uses a 1-shot NVM handoff instead of reading `supervisor.runtime.usb_connected` here:
  In CircuitPython, `boot.py` runs *before* the USB stack initializes and enumerates with
  a host computer, so `supervisor.runtime.usb_connected` is always False inside `boot.py`.

How the two filesystem modes work safely without FAT corruption:
  1. Default (Wall-Power / OTA mode):
     - Disables the USB mass-storage drive (`CIRCUITPY`) and remounts `/` read-write for
       CircuitPython (`readonly=False`) so `code.py` can roll back broken `app.py` updates
       and (in Step 18) download verified OTA firmware files.
     - USB serial (`usb_cdc`) stays enabled so `code.py` still detects when a Mac/PC USB
       host enumerates.
  2. USB Maintenance mode (`CIRCUITPY` writable by Mac/PC, read-only to CircuitPython):
     - Entered automatically when `code.py` detects `supervisor.runtime.usb_connected`,
       writes the one-shot `BOOT_MODE_USB_ONCE` flag to `microcontroller.nvm`, and resets.
       Because Boot 1 never exposed a USB disk, macOS shows zero "Disk Not Ejected Properly"
       warnings during the handoff.
     - Also entered immediately if the Feather's `BOOT` button (`board.BUTTON`) is held
       right after pressing Reset, or via CircuitPython Safe Mode.

Shared 4-byte NVM layout (`microcontroller.nvm[0:4]`):
  [0] NVM_MAGIC         = 0xA5 (guards against uninitialized 0xFF flash bytes)
  [1] NVM_BOOT_MODE     = 0 (OTA/wall power), 1 (one-shot USB R/W), 2 (one-shot force OTA over USB)
  [2] NVM_OTA_STATE     = 0 (healthy), 1 (pending OTA verification), 2 (rolled back)
  [3] NVM_BOOT_ATTEMPTS = 0..255 consecutive failed boot attempts
"""

import board
import digitalio
import microcontroller
import storage

NVM_MAGIC = 0xA5
IDX_MAGIC = 0
IDX_BOOT_MODE = 1
IDX_OTA_STATE = 2
IDX_BOOT_ATTEMPTS = 3

BOOT_MODE_OTA = 0
BOOT_MODE_USB_ONCE = 1
BOOT_MODE_FORCE_OTA = 2


def _read_nvm_header():
    """Return (initialized, boot_mode, ota_state, attempts) from microcontroller.nvm."""
    nvm = microcontroller.nvm
    if nvm is None or len(nvm) < 4 or nvm[IDX_MAGIC] != NVM_MAGIC:
        return False, BOOT_MODE_OTA, 0, 0
    return True, nvm[IDX_BOOT_MODE], nvm[IDX_OTA_STATE], nvm[IDX_BOOT_ATTEMPTS]


def _clear_usb_once_flag(ota_state, attempts):
    """Atomically clear the one-shot USB maintenance flag back to OTA mode."""
    nvm = microcontroller.nvm
    if nvm is None or len(nvm) < 4:
        return
    desired = bytes((NVM_MAGIC, BOOT_MODE_OTA, ota_state & 0xFF, attempts & 0xFF))
    if bytes(nvm[0:4]) != desired:
        nvm[0:4] = desired


def _is_boot_button_pressed():
    """Return True if the Feather ESP32-S3 BOOT button (board.BUTTON) is held low."""
    button_pin = getattr(board, "BUTTON", None)
    if button_pin is None:
        return False
    btn = None
    try:
        btn = digitalio.DigitalInOut(button_pin)
        btn.switch_to_input(pull=digitalio.Pull.UP)
        return not btn.value
    except Exception:
        return False
    finally:
        if btn is not None:
            try:
                btn.deinit()
            except Exception:
                pass


def configure_filesystem():
    """Select USB host R/W maintenance mode or CircuitPython R/W OTA mode."""
    initialized, boot_mode, ota_state, attempts = _read_nvm_header()
    button_held = _is_boot_button_pressed()

    if button_held or boot_mode == BOOT_MODE_USB_ONCE:
        if initialized and boot_mode == BOOT_MODE_USB_ONCE:
            _clear_usb_once_flag(ota_state, attempts)
        reason = "BOOT button held" if button_held else "USB host handoff"
        print(
            "[boot.py] USB maintenance mode ({}): CIRCUITPY writable by host, read-only to Python.".format(
                reason
            )
        )
        return "usb_host"

    storage.disable_usb_drive()
    storage.remount("/", readonly=False)
    mode_label = (
        "forced OTA-over-USB" if boot_mode == BOOT_MODE_FORCE_OTA else "wall-power / OTA"
    )
    print(
        "[boot.py] {} mode: USB drive disabled, / mounted read-write for Python.".format(
            mode_label
        )
    )
    return "python_rw"


if __name__ == "__main__":
    configure_filesystem()
