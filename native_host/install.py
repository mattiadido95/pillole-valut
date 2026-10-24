#!/usr/bin/env python3
"""Manually register the local bridge for the current macOS user's Edge Stable.

This script installs no dependencies and never starts Codex or opens the vault notes.
It is intentionally not executed as part of development or by the extension.
"""

import argparse
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import sys
import tempfile

HOST_NAME = "com.mattia.pillole_valut"


class InstallError(Exception):
    pass


def _absolute_file(path, description):
    try:
        # Preserve a stable CLI symlink (for example ~/.local/bin/codex) across updates.
        candidate = Path(os.path.abspath(str(Path(path).expanduser())))
        candidate.resolve(strict=True)
    except (OSError, ValueError):
        raise InstallError(description + " non trovato.") from None
    if not candidate.is_file() or not os.access(str(candidate), os.X_OK):
        raise InstallError(description + " non è un eseguibile valido.")
    return candidate


def _find_codex(codex_path=None, home=None):
    if codex_path is not None:
        return _absolute_file(codex_path, "Codex CLI")
    candidates = [shutil.which("codex"), str(Path(home or Path.home()) / ".local/bin/codex")]
    for candidate in candidates:
        if candidate:
            try:
                return _absolute_file(candidate, "Codex CLI")
            except InstallError:
                continue
    raise InstallError("Codex CLI non trovato. Specifica il percorso assoluto con --codex.")


def build_installation(extension_id, vault_path, codex_path=None, home=None):
    """Prepare and preflight paths/content; do not write anything."""
    if not isinstance(extension_id, str) or re.fullmatch(r"[a-p]{32}", extension_id) is None:
        raise InstallError("L'ID estensione deve contenere esattamente 32 lettere da a a p.")
    try:
        vault = Path(vault_path).expanduser().resolve(strict=True)
    except (OSError, ValueError, TypeError):
        raise InstallError("La cartella del vault non esiste.") from None
    if not vault.is_dir() or not os.access(str(vault), os.R_OK | os.X_OK):
        raise InstallError("La cartella del vault non è leggibile.")
    user_home = Path(home or Path.home()).expanduser().resolve()
    codex = _find_codex(codex_path, user_home)
    python = _absolute_file(sys.executable, "Python")
    host = Path(__file__).resolve().with_name("host.py")
    schema = host.with_name("output-schema.json")
    if not host.is_file() or not schema.is_file():
        raise InstallError("I file host.py e output-schema.json devono restare nella cartella native_host del progetto.")
    data_dir = user_home / "Library/Application Support/PilloleVault"
    config_path = data_dir / "config.json"
    launcher_path = data_dir / "native-host"
    manifest_path = user_home / "Library/Application Support/Microsoft Edge/NativeMessagingHosts" / (HOST_NAME + ".json")
    config = {"version": 1, "vaultPath": str(vault), "codexPath": str(codex)}
    manifest = {
        "name": HOST_NAME,
        "description": "Pillole Vault: note locali e generazione con Codex CLI",
        "path": str(launcher_path),
        "type": "stdio",
        "allowed_origins": ["chrome-extension://" + extension_id + "/"],
    }
    launcher = "#!/bin/sh\nexec " + " ".join(shlex.quote(str(value)) for value in (python, host, "--config", config_path)) + ' "$@"\n' 
    return {
        "configPath": config_path,
        "launcherPath": launcher_path,
        "manifestPath": manifest_path,
        "config": config,
        "manifest": manifest,
        "launcher": launcher,
    }


def _check_destination(path, force):
    # Refuse link-based writes even with --force; it is never necessary here.
    for ancestor in (path,) + tuple(path.parents):
        if ancestor.is_symlink():
            raise InstallError("Destinazione con collegamento simbolico non consentita: " + str(ancestor))
    if path.exists():
        if not path.is_file():
            raise InstallError("La destinazione esiste e non è un file: " + str(path))
        if not force:
            raise InstallError("Registrazione già presente. Per aggiornarla usa --force: " + str(path))
    parent = path.parent
    while not parent.exists() and parent != parent.parent:
        parent = parent.parent
    if not parent.is_dir() or not os.access(str(parent), os.W_OK | os.X_OK):
        raise InstallError("Cartella di destinazione non scrivibile: " + str(parent))


def _write_file(path, content, mode, force):
    path.parent.mkdir(parents=True, exist_ok=True)
    if not force:
        # Exclusive creation also prevents an overwrite after preflight races.
        descriptor = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(content)
        return
    descriptor, temporary = tempfile.mkstemp(prefix=".pillole-", dir=str(path.parent))
    try:
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(content)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def install_host(extension_id, vault_path, codex_path=None, force=False, home=None):
    """Register after preflight. `home` enables isolated tests without real user writes."""
    prepared = build_installation(extension_id, vault_path, codex_path, home)
    destinations = (prepared["configPath"], prepared["launcherPath"], prepared["manifestPath"])
    for path in destinations:
        _check_destination(path, force)
    try:
        _write_file(prepared["configPath"], json.dumps(prepared["config"], ensure_ascii=False, indent=2) + "\n", 0o600, force)
        _write_file(prepared["launcherPath"], prepared["launcher"], 0o700, force)
        _write_file(prepared["manifestPath"], json.dumps(prepared["manifest"], ensure_ascii=False, indent=2) + "\n", 0o600, force)
    except OSError:
        raise InstallError("Registrazione non completata. Controlla i permessi delle destinazioni prima di riprovare; alcuni file potrebbero essere stati creati.") from None
    return prepared


def main(argv=None):
    parser = argparse.ArgumentParser(description="Registra manualmente il ponte Pillole Vault in Edge Stable su macOS.")
    parser.add_argument("--extension-id", required=True, help="ID da edge://extensions (32 lettere)")
    parser.add_argument("--vault", required=True, type=Path, help="Cartella del vault Obsidian")
    parser.add_argument("--codex", type=Path, help="Percorso Codex CLI; default PATH oppure ~/.local/bin/codex")
    parser.add_argument("--force", action="store_true", help="Aggiorna esclusivamente i tre file del ponte già registrati")
    args = parser.parse_args(argv)
    if sys.platform != "darwin":
        print("Questo installer è destinato a macOS con Microsoft Edge Stable.", file=sys.stderr)
        return 1
    try:
        result = install_host(args.extension_id, args.vault, args.codex, args.force)
    except InstallError as error:
        print(str(error), file=sys.stderr)
        return 1
    print("Ponte registrato per l'utente corrente. Nessuna generazione avviata.")
    print("Configurazione: " + str(result["configPath"]))
    print("Manifest Edge: " + str(result["manifestPath"]))
    print("Ricarica l'estensione in Edge e usa Controlla ponte, poi Prepara scorta.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
