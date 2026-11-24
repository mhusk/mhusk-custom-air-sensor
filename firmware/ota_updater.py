"""Pull-based SHA-256 verified OTA updater for Adafruit Feather ESP32-S3.

Pure-Python module compatible with both CircuitPython 9/10 and CPython 3 (for offline
verification on macOS/Linux). Works in tandem with `boot.py` and the immutable `code.py`
auto-rollback bootloader:

  1. Compares running `FIRMWARE_VERSION` against `device_configs.target_firmware_version`.
  2. Skips cleanly when up to date, in USB read-only mode, or when the target version
     matches a release that already triggered an automatic rollback (preventing loops).
  3. Fetches `firmware_releases/{version}` and verifies `status == "active"`,
     `min_bootloader_version`, and every filename against protected-file guards.
  4. Downloads each `.py` payload one at a time to `<filename>.new`, verifies exact UTF-8
     byte length and SHA-256 digest both in memory and after reading back from flash.
  5. If ANY file fails download or checksum verification, removes all `.new` staging
     files, leaves live `.py` files untouched, and returns an error without rebooting.
  6. Only after every file passes SHA-256 verification: reports `ota_status="updating"`,
     writes `/ota_pending.txt`, sets `NVM_OTA_STATE = OTA_STATE_PENDING`, backs up live
     files to `*.py.bak`, atomically promotes `*.py.new -> *.py` (`app.py` last), and
     resets the microcontroller.
"""

import gc
import hashlib
import os
import sys

import firestore_client

# Shared 4-byte NVM header (must match firmware/boot.py and firmware/code.py)
NVM_MAGIC = 0xA5
BOOT_MODE_OTA = 0
BOOT_MODE_USB_ONCE = 1
BOOT_MODE_FORCE_OTA = 2

OTA_STATE_HEALTHY = 0
OTA_STATE_PENDING = 1
OTA_STATE_ROLLED_BACK = 2

DEFAULT_BOOTLOADER_VERSION = "1.0.0"
MAX_OTA_FILE_BYTES = 512 * 1024
MAX_OTA_ERROR_LEN = 200

PENDING_VERSION_FILE = "ota_pending.txt"
FAILED_VERSION_FILE = "ota_failed_version.txt"
BOOT_ERROR_FILE = "boot_error.txt"


class OtaError(Exception):
    """Raised when an OTA manifest, download, checksum, or flash swap fails."""


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


def _truncate_error(message, limit=MAX_OTA_ERROR_LEN):
    text = str(message).replace("\r", " ").replace("\n", " ").strip()
    if len(text) <= limit:
        return text
    return text[: limit - 3] + "..."


def sha256_hex(data_bytes):
    """Return 64-char lowercase hex SHA-256 digest (CircuitPython + CPython safe).

    CircuitPython's built-in `hashlib` exposes `hashlib.new("sha256")` and `.digest()`
    (not `hashlib.sha256()` or `.hexdigest()`), whereas CPython supports both.
    """
    if hasattr(hashlib, "sha256"):
        h = hashlib.sha256(data_bytes)
    else:
        h = hashlib.new("sha256")
        h.update(data_bytes)
    digest = h.digest()
    return "".join("{:02x}".format(b) for b in digest)


def is_valid_sha256(value):
    """Return True if `value` is a 64-character lowercase hex SHA-256 digest."""
    if not isinstance(value, str) or len(value) != 64:
        return False
    for ch in value:
        if not (("0" <= ch <= "9") or ("a" <= ch <= "f")):
            return False
    return True


def parse_semver_core(version):
    """Parse major.minor.patch tuple from a validated SemVer string."""
    if not firestore_client.is_valid_firmware_version(version):
        raise OtaError("Invalid SemVer version: {!r}".format(version))
    core = version.split("-", 1)[0]
    parts = core.split(".")
    return int(parts[0]), int(parts[1]), int(parts[2])


def is_bootloader_compatible(current_version, min_required_version):
    """Return True when `current_version >= min_required_version` (core SemVer)."""
    return parse_semver_core(current_version) >= parse_semver_core(min_required_version)


def detect_bootloader_version():
    """Return the active `code.py` BOOTLOADER_VERSION if importable, else default."""
    code_mod = sys.modules.get("code")
    ver = getattr(code_mod, "BOOTLOADER_VERSION", None)
    if isinstance(ver, str) and firestore_client.is_valid_firmware_version(ver):
        return ver
    return DEFAULT_BOOTLOADER_VERSION


def is_fs_readonly():
    """Return True if CircuitPython flash `/` is mounted read-only (USB mode)."""
    try:
        import storage

        return bool(storage.getmount("/").readonly)
    except Exception:
        return False


def _get_nvm(nvm=None):
    if nvm is not None:
        return nvm
    try:
        import microcontroller

        return microcontroller.nvm
    except Exception:
        return None


def read_nvm_ota_state(nvm=None):
    """Return (boot_mode, ota_state, attempts) from the shared 4-byte NVM header."""
    buf = _get_nvm(nvm)
    if buf is None or len(buf) < 4 or buf[0] != NVM_MAGIC:
        return BOOT_MODE_OTA, OTA_STATE_HEALTHY, 0
    return buf[1], buf[2], buf[3]


def write_nvm_ota_state(boot_mode, ota_state, attempts, nvm=None):
    """Atomically write the 4-byte NVM header only when bytes actually change."""
    buf = _get_nvm(nvm)
    if buf is None or len(buf) < 4:
        return
    desired = bytes((NVM_MAGIC, boot_mode & 0xFF, ota_state & 0xFF, attempts & 0xFF))
    if bytes(buf[0:4]) != desired:
        buf[0:4] = desired


def read_text_file(root_dir, filename, max_bytes=512):
    """Read and strip a small UTF-8 text file, returning None if missing/unreadable."""
    path = _join(root_dir, filename)
    if not _exists(path):
        return None
    try:
        with open(path, "r") as fh:
            data = fh.read(max_bytes)
        text = str(data).strip()
        return text if text else None
    except Exception:
        return None


def write_text_file(root_dir, filename, text):
    """Write a small UTF-8 text file (single overwrite)."""
    path = _join(root_dir, filename)
    with open(path, "w") as fh:
        fh.write(str(text))


def remove_file_if_exists(root_dir, filename):
    """Remove a file if present; ignore missing files."""
    path = _join(root_dir, filename)
    if _exists(path):
        os.remove(path)


def cleanup_staging_files(root_dir="/"):
    """Remove any leftover `*.py.new` staging files in `root_dir`."""
    removed = []
    try:
        entries = os.listdir(root_dir)
    except OSError:
        return removed
    for name in entries:
        if name.endswith(".py.new"):
            try:
                os.remove(_join(root_dir, name))
                removed.append(name)
            except OSError:
                pass
    return removed


def cleanup_backup_files(root_dir="/"):
    """Remove stale non-protected `*.py.bak` files before creating a fresh backup set."""
    removed = []
    try:
        entries = os.listdir(root_dir)
    except OSError:
        return removed
    for name in entries:
        if name.endswith(".py.bak"):
            target_name = name[:-4]
            if target_name not in firestore_client.PROTECTED_OTA_FILES:
                try:
                    os.remove(_join(root_dir, name))
                    removed.append(name)
                except OSError:
                    pass
    return removed


def _extract_boot_error_summary(root_dir="/"):
    """Read a concise one-line summary from `/boot_error.txt` if present."""
    raw = read_text_file(root_dir, BOOT_ERROR_FILE, max_bytes=1024)
    if not raw:
        return None
    lines = [line.strip() for line in raw.splitlines() if line.strip()]
    if not lines:
        return None
    return _truncate_error(lines[-1], limit=140)


def check_post_boot_ota_state(
    current_version,
    root_dir="/",
    nvm=None,
    fs_readonly=None,
):
    """Inspect NVM and marker files on boot to detect pending OTA or rollback state."""
    if fs_readonly is None:
        fs_readonly = is_fs_readonly()

    _, ota_state, _ = read_nvm_ota_state(nvm=nvm)
    pending_ver = read_text_file(root_dir, PENDING_VERSION_FILE, max_bytes=64)
    failed_ver = read_text_file(root_dir, FAILED_VERSION_FILE, max_bytes=64)

    if pending_ver and not firestore_client.is_valid_firmware_version(pending_ver):
        pending_ver = None
    if failed_ver and not firestore_client.is_valid_firmware_version(failed_ver):
        failed_ver = None

    if ota_state == OTA_STATE_ROLLED_BACK:
        if pending_ver and pending_ver != current_version:
            failed_ver = pending_ver
            if not fs_readonly:
                try:
                    write_text_file(root_dir, FAILED_VERSION_FILE, failed_ver)
                    remove_file_if_exists(root_dir, PENDING_VERSION_FILE)
                except OSError:
                    pass
        boot_summary = _extract_boot_error_summary(root_dir)
        if failed_ver and boot_summary:
            err_msg = "Rolled back from {}: {}".format(failed_ver, boot_summary)
        elif failed_ver:
            err_msg = "Rolled back from {} after boot failure".format(failed_ver)
        elif boot_summary:
            err_msg = "Rolled back after boot failure: {}".format(boot_summary)
        else:
            err_msg = "Rolled back to {} after boot failure".format(current_version)
        return {
            "ota_state": OTA_STATE_ROLLED_BACK,
            "failed_version": failed_ver,
            "ota_status": "rolled_back",
            "ota_last_error": _truncate_error(err_msg),
        }

    return {
        "ota_state": ota_state,
        "failed_version": failed_ver,
        "ota_status": "up_to_date",
        "ota_last_error": None,
    }


def confirm_ota_healthy(
    on_healthy=None,
    clear_rolled_back=False,
    root_dir="/",
    fs_readonly=None,
):
    """Confirm healthy boot with `code.py` and clean up OTA marker files."""
    if fs_readonly is None:
        fs_readonly = is_fs_readonly()

    if on_healthy is not None:
        if clear_rolled_back:
            on_healthy(clear_rolled_back=True)
        else:
            on_healthy()

    if not fs_readonly:
        try:
            remove_file_if_exists(root_dir, PENDING_VERSION_FILE)
            if clear_rolled_back:
                remove_file_if_exists(root_dir, FAILED_VERSION_FILE)
        except OSError:
            pass


def validate_release_manifest(
    manifest,
    target_version,
    bootloader_version=DEFAULT_BOOTLOADER_VERSION,
):
    """Validate a decoded `firmware_releases/{version}` manifest.

    Returns a sorted list of `(filename, doc_id, sha256, size_bytes)` tuples or raises
    `OtaError` on any schema, version, status, bootloader, or protected-file violation.
    """
    if not isinstance(manifest, dict):
        raise OtaError("Release manifest for {} not found".format(target_version))

    manifest_version = manifest.get("version")
    if manifest_version != target_version:
        raise OtaError(
            "Manifest version mismatch: expected {}, got {!r}".format(
                target_version, manifest_version
            )
        )

    status = manifest.get("status")
    if status != "active":
        raise OtaError(
            "Release {} is not active (status={!r})".format(target_version, status)
        )

    min_bootloader = manifest.get("min_bootloader_version", DEFAULT_BOOTLOADER_VERSION)
    if not firestore_client.is_valid_firmware_version(min_bootloader):
        raise OtaError("Invalid min_bootloader_version: {!r}".format(min_bootloader))
    if not is_bootloader_compatible(bootloader_version, min_bootloader):
        raise OtaError(
            "Bootloader v{} is older than required v{}".format(
                bootloader_version, min_bootloader
            )
        )

    files_map = manifest.get("files")
    if not isinstance(files_map, dict) or not files_map:
        raise OtaError("Release {} manifest has no files".format(target_version))

    if "app.py" not in files_map:
        raise OtaError("Release {} manifest is missing required app.py".format(target_version))

    validated = []
    for filename in sorted(files_map.keys()):
        if not firestore_client.is_valid_ota_filename(filename):
            raise OtaError("Blocked or invalid OTA filename: {!r}".format(filename))

        entry = files_map[filename]
        if not isinstance(entry, dict):
            raise OtaError("Invalid manifest entry for {}".format(filename))

        doc_id = entry.get("doc_id", filename)
        if doc_id != filename or not firestore_client.is_valid_ota_filename(doc_id):
            raise OtaError("Invalid doc_id {!r} for {}".format(doc_id, filename))

        expected_sha = entry.get("sha256")
        if not is_valid_sha256(expected_sha):
            raise OtaError("Invalid SHA-256 digest in manifest for {}".format(filename))

        expected_size = entry.get("size_bytes")
        if (
            not isinstance(expected_size, int)
            or isinstance(expected_size, bool)
            or expected_size <= 0
            or expected_size > MAX_OTA_FILE_BYTES
        ):
            raise OtaError("Invalid size_bytes for {}: {!r}".format(filename, expected_size))

        validated.append((filename, doc_id, expected_sha, expected_size))

    return validated


def stage_and_verify_files(
    client,
    target_version,
    file_entries,
    root_dir="/",
    feed_watchdog_fn=None,
):
    """Download each `.py` artifact to `<filename>.new` and verify SHA-256 twice.

    Verifies exact UTF-8 byte length and SHA-256 both in RAM before writing and again
    after reading the staged `.new` file back from flash. On any failure, deletes all
    staged `.new` files so live `.py` files remain completely untouched.
    """
    cleanup_staging_files(root_dir)
    staged_filenames = []

    try:
        for filename, doc_id, expected_sha, expected_size in file_entries:
            if feed_watchdog_fn is not None:
                feed_watchdog_fn()
            gc.collect()

            artifact = client.fetch_firmware_release_file(target_version, doc_id)
            if not isinstance(artifact, dict):
                raise OtaError("Missing artifact document {}/{}".format(target_version, doc_id))

            if artifact.get("filename", filename) != filename:
                raise OtaError(
                    "Artifact filename mismatch for {}: got {!r}".format(
                        filename, artifact.get("filename")
                    )
                )

            if artifact.get("encoding", "utf-8") != "utf-8":
                raise OtaError(
                    "Unsupported encoding for {}: {!r}".format(
                        filename, artifact.get("encoding")
                    )
                )

            content = artifact.get("content")
            if not isinstance(content, str):
                raise OtaError("Artifact {} has non-string content".format(filename))

            raw_bytes = content.encode("utf-8")
            if len(raw_bytes) != expected_size:
                raise OtaError(
                    "Size mismatch for {}: expected {} bytes, got {}".format(
                        filename, expected_size, len(raw_bytes)
                    )
                )

            actual_sha = sha256_hex(raw_bytes)
            if actual_sha != expected_sha:
                raise OtaError(
                    "SHA-256 mismatch for {}: expected {}..., got {}...".format(
                        filename, expected_sha[:12], actual_sha[:12]
                    )
                )

            doc_sha = artifact.get("sha256")
            if doc_sha is not None and doc_sha != expected_sha:
                raise OtaError(
                    "Artifact doc SHA-256 disagrees with manifest for {}".format(filename)
                )

            staged_path = _join(root_dir, filename + ".new")
            with open(staged_path, "wb") as fh:
                fh.write(raw_bytes)

            # Release payload buffer before flash read-back verification.
            raw_bytes = None
            content = None
            artifact = None
            gc.collect()

            if feed_watchdog_fn is not None:
                feed_watchdog_fn()

            with open(staged_path, "rb") as fh:
                disk_bytes = fh.read()
            if len(disk_bytes) != expected_size or sha256_hex(disk_bytes) != expected_sha:
                raise OtaError("Flash read-back SHA-256 mismatch for {}".format(filename))

            disk_bytes = None
            gc.collect()
            staged_filenames.append(filename)

        return staged_filenames
    except Exception:
        cleanup_staging_files(root_dir)
        raise


def apply_staged_update(
    staged_filenames,
    target_version,
    root_dir="/",
    nvm=None,
    feed_watchdog_fn=None,
):
    """Atomically back up live `.py` files to `.bak` and promote `.new` -> live.

    Writes `ota_pending.txt`, sets `NVM_OTA_STATE = OTA_STATE_PENDING`, removes stale
    `.bak` files from prior updates, and swaps `app.py` last so `code.py` can self-heal
    or roll back cleanly if power is lost at any point.
    """
    if not staged_filenames:
        raise OtaError("No staged files to apply")

    for filename in staged_filenames:
        if not firestore_client.is_valid_ota_filename(filename):
            raise OtaError("Refusing to swap protected/invalid file: {!r}".format(filename))
        if not _exists(_join(root_dir, filename + ".new")):
            raise OtaError("Missing staged file {}.new".format(filename))

    write_text_file(root_dir, PENDING_VERSION_FILE, target_version)
    write_nvm_ota_state(BOOT_MODE_OTA, OTA_STATE_PENDING, 0, nvm=nvm)
    cleanup_backup_files(root_dir)

    ordered = [f for f in staged_filenames if f != "app.py"]
    if "app.py" in staged_filenames:
        ordered.append("app.py")

    swapped = []
    for filename in ordered:
        if feed_watchdog_fn is not None:
            feed_watchdog_fn()
        live_path = _join(root_dir, filename)
        bak_path = _join(root_dir, filename + ".bak")
        new_path = _join(root_dir, filename + ".new")

        if _exists(bak_path):
            os.remove(bak_path)
        if _exists(live_path):
            os.rename(live_path, bak_path)
        os.rename(new_path, live_path)
        swapped.append(filename)

    if hasattr(os, "sync"):
        try:
            os.sync()
        except Exception:
            pass

    return swapped


def _default_reset():
    import microcontroller

    microcontroller.reset()


def perform_ota_update(
    client,
    current_version,
    target_version,
    failed_version=None,
    root_dir="/",
    nvm=None,
    bootloader_version=None,
    fs_readonly=None,
    feed_watchdog_fn=None,
    on_before_swap=None,
    reset_fn=None,
):
    """Check, download, SHA-256 verify, swap, and reboot into `target_version`.

    Returns a dict with keys:
      - `action`: one of `"up_to_date"`, `"skipped_rolled_back"`, `"skipped_usb"`,
                  `"error"`, `"updated"`
      - `ota_status`: `"up_to_date"`, `"rolled_back"`, `"updating"`, or `"error"`
      - `ota_target_version`: target version string or `None`
      - `ota_last_error`: concise error message or `None`
      - `swapped_files`: list of swapped filenames (only for `"updated"`)
    """
    if not target_version or target_version == current_version:
        return {
            "action": "up_to_date",
            "ota_status": "up_to_date",
            "ota_target_version": target_version,
            "ota_last_error": None,
        }

    if not firestore_client.is_valid_firmware_version(target_version):
        return {
            "action": "error",
            "ota_status": "error",
            "ota_target_version": None,
            "ota_last_error": _truncate_error(
                "Invalid target_firmware_version: {!r}".format(target_version)
            ),
        }

    if failed_version and target_version == failed_version:
        return {
            "action": "skipped_rolled_back",
            "ota_status": "rolled_back",
            "ota_target_version": target_version,
            "ota_last_error": _truncate_error(
                "Skipping {} (previously rolled back)".format(target_version)
            ),
        }

    if fs_readonly is None:
        fs_readonly = is_fs_readonly()
    if fs_readonly:
        return {
            "action": "skipped_usb",
            "ota_status": "error",
            "ota_target_version": target_version,
            "ota_last_error": "USB read-only mode; move to wall power for OTA",
        }

    if bootloader_version is None:
        bootloader_version = detect_bootloader_version()

    try:
        if feed_watchdog_fn is not None:
            feed_watchdog_fn()
        manifest = client.fetch_firmware_release(target_version)
        file_entries = validate_release_manifest(
            manifest,
            target_version=target_version,
            bootloader_version=bootloader_version,
        )
        staged_filenames = stage_and_verify_files(
            client=client,
            target_version=target_version,
            file_entries=file_entries,
            root_dir=root_dir,
            feed_watchdog_fn=feed_watchdog_fn,
        )
    except Exception as err:
        cleanup_staging_files(root_dir)
        return {
            "action": "error",
            "ota_status": "error",
            "ota_target_version": target_version,
            "ota_last_error": _truncate_error(err),
        }

    # Notify cloud (`ota_status="updating"`) before mutating live files & resetting.
    if on_before_swap is not None:
        try:
            on_before_swap(target_version)
        except Exception as status_err:
            print("[OTA WARN] Could not report updating status: {}".format(status_err))

    try:
        swapped = apply_staged_update(
            staged_filenames=staged_filenames,
            target_version=target_version,
            root_dir=root_dir,
            nvm=nvm,
            feed_watchdog_fn=feed_watchdog_fn,
        )
    except Exception as err:
        cleanup_staging_files(root_dir)
        return {
            "action": "error",
            "ota_status": "error",
            "ota_target_version": target_version,
            "ota_last_error": _truncate_error("Swap failed: {}".format(err)),
        }

    print(
        "[OTA] Swapped {} -> v{}; rebooting to verify...".format(
            swapped, target_version
        )
    )
    if reset_fn is None:
        reset_fn = _default_reset
    reset_fn()

    return {
        "action": "updated",
        "ota_status": "updating",
        "ota_target_version": target_version,
        "ota_last_error": None,
        "swapped_files": swapped,
    }
