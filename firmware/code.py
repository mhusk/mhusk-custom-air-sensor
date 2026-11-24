"""Minimal immutable bootloader for Adafruit Feather ESP32-S3 (CircuitPython).

This file is intentionally tiny, uses ONLY CircuitPython built-in modules, and is
NEVER overwritten by OTA updates. Its sole job is to:
  1. Coordinate USB maintenance mode with `boot.py` via a 1-shot NVM handoff whenever
     a Mac/PC USB host is detected (`supervisor.runtime.usb_connected`).
  2. Self-heal an interrupted OTA file swap if `app.py` is missing while `app.py.bak` exists.
  3. Guard pending OTA verification with the hardware watchdog and a boot-attempt counter.
  4. Import and execute `app.main(on_healthy=mark_boot_healthy)`.
  5. Automatically roll back all `*.py.bak` files (never touching `boot.py`, `code.py`,
     or `settings.toml`), save crash forensics to `/boot_error.txt`, and reboot if `app.py`
     crashes repeatedly on wall power.
"""

import os
import time

import microcontroller
import storage
import supervisor
from microcontroller import watchdog as wdt
from watchdog import WatchDogMode

BOOTLOADER_VERSION = "1.0.0"

# Shared 4-byte NVM header (must match firmware/boot.py)
NVM_MAGIC = 0xA5
BOOT_MODE_OTA = 0
BOOT_MODE_USB_ONCE = 1
BOOT_MODE_FORCE_OTA = 2

OTA_STATE_HEALTHY = 0
OTA_STATE_PENDING = 1
OTA_STATE_ROLLED_BACK = 2

MAX_BOOT_ATTEMPTS = 2
USB_DETECT_TIMEOUT_SECONDS = 1.5
WDT_BOOT_TIMEOUT_SECONDS = 60
PROTECTED_FILES = ("boot.py", "code.py", "settings.toml")


def _join(root_dir, name):
    if root_dir == "/":
        return "/" + name
    return root_dir.rstrip("/") + "/" + name


def _exists(path):
    try:
        os.stat(path)
        return True
    except OSError:
        return False


def is_fs_readonly():
    try:
        return bool(storage.getmount("/").readonly)
    except Exception:
        return True


def read_nvm_state():
    """Return (boot_mode, ota_state, attempts) from microcontroller.nvm."""
    nvm = microcontroller.nvm
    if nvm is None or len(nvm) < 4 or nvm[0] != NVM_MAGIC:
        return BOOT_MODE_OTA, OTA_STATE_HEALTHY, 0
    return nvm[1], nvm[2], nvm[3]


def write_nvm_state(boot_mode, ota_state, attempts):
    """Atomically write the 4-byte NVM header only when bytes actually change."""
    nvm = microcontroller.nvm
    if nvm is None or len(nvm) < 4:
        return
    desired = bytes((NVM_MAGIC, boot_mode & 0xFF, ota_state & 0xFF, attempts & 0xFF))
    if bytes(nvm[0:4]) != desired:
        nvm[0:4] = desired


def mark_boot_healthy(clear_rolled_back=False):
    """Confirm `app.py` booted and published cleanly; clears pending verification."""
    boot_mode, ota_state, attempts = read_nvm_state()
    next_state = ota_state
    if ota_state == OTA_STATE_PENDING or (
        clear_rolled_back and ota_state == OTA_STATE_ROLLED_BACK
    ):
        next_state = OTA_STATE_HEALTHY
    if next_state != ota_state or attempts != 0:
        write_nvm_state(boot_mode, next_state, 0)
        print("[BOOT] Boot confirmed healthy (NVM verification cleared).")


def find_backup_files(root_dir="/"):
    """Return sorted list of rollbackable `*.py.bak` filenames in `root_dir`."""
    backups = []
    try:
        entries = os.listdir(root_dir)
    except OSError:
        return backups
    for name in entries:
        if name.endswith(".py.bak"):
            target_name = name[:-4]
            if target_name not in PROTECTED_FILES:
                backups.append(name)
    backups.sort()
    return backups


def rollback_backups(root_dir="/"):
    """Power-loss-safe restore of every `*.py.bak` -> `*.py` (saves broken file as `.failed`)."""
    restored = []
    for bak_name in find_backup_files(root_dir):
        target_name = bak_name[:-4]
        bak_path = _join(root_dir, bak_name)
        target_path = _join(root_dir, target_name)
        failed_path = target_path + ".failed"

        if _exists(failed_path):
            os.remove(failed_path)
        if _exists(target_path):
            os.rename(target_path, failed_path)
        os.rename(bak_path, target_path)
        restored.append(target_name)
    return restored


def write_boot_error(err, root_dir="/"):
    """Persist the latest boot crash reason to `/boot_error.txt` (single overwrite)."""
    try:
        err_path = _join(root_dir, "boot_error.txt")
        lines = None
        try:
            import traceback

            lines = traceback.format_exception(
                type(err), err, getattr(err, "__traceback__", None)
            )
        except Exception:
            lines = None
        with open(err_path, "w") as fh:
            if lines:
                fh.write("".join(lines))
            else:
                fh.write("{}: {}\n".format(type(err).__name__, err))
    except Exception:
        pass


def _feed_watchdog_safe():
    try:
        if wdt.mode is not None:
            wdt.feed()
    except Exception:
        pass


def _arm_boot_watchdog():
    try:
        wdt.timeout = WDT_BOOT_TIMEOUT_SECONDS
        wdt.mode = WatchDogMode.RESET
        wdt.feed()
    except Exception:
        pass


def _reset_after(delay_seconds):
    _feed_watchdog_safe()
    if delay_seconds > 0:
        time.sleep(delay_seconds)
    _feed_watchdog_safe()
    microcontroller.reset()


def maybe_switch_to_usb_mode(boot_mode, ota_state, attempts, fs_readonly):
    """If plugged into a USB host while `/` is Python-writable, hand off to USB R/W mode."""
    if fs_readonly:
        return False

    if boot_mode == BOOT_MODE_FORCE_OTA:
        # Clear one-shot developer override so future USB boots mount CIRCUITPY normally.
        write_nvm_state(BOOT_MODE_OTA, ota_state, attempts)
        print("[BOOT] Forced OTA-over-USB mode active for this boot.")
        return False

    deadline = time.monotonic() + USB_DETECT_TIMEOUT_SECONDS
    while True:
        if getattr(supervisor.runtime, "usb_connected", False):
            print("[BOOT] USB host detected; rebooting into USB maintenance mode...")
            write_nvm_state(BOOT_MODE_USB_ONCE, ota_state, attempts)
            _reset_after(0.2)
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(0.1)


def _perform_rollback_and_reset(root_dir, reason):
    restored = rollback_backups(root_dir)
    print("[BOOT] {}: restored {} -> rebooting...".format(reason, restored))
    write_nvm_state(BOOT_MODE_OTA, OTA_STATE_ROLLED_BACK, 0)
    _reset_after(1.0)
    return restored


def boot_main(root_dir="/"):
    boot_mode, ota_state, attempts = read_nvm_state()
    fs_readonly = is_fs_readonly()

    if maybe_switch_to_usb_mode(boot_mode, ota_state, attempts, fs_readonly):
        return "switched_to_usb"

    # 1. Self-heal an interrupted swap if `app.py` is missing while `app.py.bak` exists.
    if (
        not fs_readonly
        and not _exists(_join(root_dir, "app.py"))
        and _exists(_join(root_dir, "app.py.bak"))
    ):
        _perform_rollback_and_reset(root_dir, "Missing app.py with backup present")
        return "rolled_back"

    # 2. Enforce watchdog-hang rollback for pending OTA updates BEFORE importing `app`.
    if ota_state == OTA_STATE_PENDING:
        if attempts >= MAX_BOOT_ATTEMPTS:
            if not fs_readonly and find_backup_files(root_dir):
                _perform_rollback_and_reset(
                    root_dir,
                    "Pending OTA failed {} boot attempts".format(attempts),
                )
                return "rolled_back"
            write_nvm_state(BOOT_MODE_OTA, OTA_STATE_HEALTHY, 0)
            ota_state = OTA_STATE_HEALTHY
            attempts = 0
        else:
            attempts = min(attempts + 1, 255)
            write_nvm_state(BOOT_MODE_OTA, OTA_STATE_PENDING, attempts)
            if not fs_readonly:
                _arm_boot_watchdog()

    print(
        "[BOOT] Bootloader v{} | fs={} | ota_state={} | attempts={}".format(
            BOOTLOADER_VERSION,
            "ro(USB)" if fs_readonly else "rw(OTA)",
            ota_state,
            attempts,
        )
    )
    if ota_state == OTA_STATE_ROLLED_BACK:
        print("[BOOT] Running known-good firmware restored via automatic rollback.")

    # 3. Load and run `app.py`.
    try:
        import app

        if getattr(app, "SUPPORTS_HEALTH_CALLBACK", False):
            app.main(on_healthy=mark_boot_healthy)
        else:
            app.main()
        raise RuntimeError("app.main() exited unexpectedly")
    except KeyboardInterrupt:
        print("\n[BOOT] Interrupted by user; returning to REPL.")
        raise
    except Exception as err:
        print("[BOOT ERROR] app.py crashed: {}: {}".format(type(err).__name__, err))
        try:
            import traceback

            traceback.print_exception(
                type(err), err, getattr(err, "__traceback__", None)
            )
        except Exception:
            pass

        if fs_readonly:
            print(
                "[BOOT] Flash is read-only (USB mode); rollback skipped. "
                "Fix app.py on CIRCUITPY to auto-reload."
            )
            return "usb_error"

        write_boot_error(err, root_dir)
        _, cur_state, cur_attempts = read_nvm_state()
        if cur_state != OTA_STATE_PENDING:
            cur_attempts = min(cur_attempts + 1, 255)
            write_nvm_state(BOOT_MODE_OTA, cur_state, cur_attempts)

        if cur_attempts >= MAX_BOOT_ATTEMPTS and find_backup_files(root_dir):
            _perform_rollback_and_reset(
                root_dir,
                "app.py crashed {}/{} times".format(cur_attempts, MAX_BOOT_ATTEMPTS),
            )
            return "rolled_back"

        if find_backup_files(root_dir):
            print(
                "[BOOT] Boot attempt {}/{} failed; resetting to retry...".format(
                    cur_attempts, MAX_BOOT_ATTEMPTS
                )
            )
            _reset_after(2.0)
            return "retry_reset"

        print("[BOOT] No .bak backup found; waiting 15s before retry reset...")
        _reset_after(15.0)
        return "no_backup_reset"


if __name__ == "__main__":
    boot_main()
