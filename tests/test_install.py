"""Registrazione host provata soltanto in una home temporanea, mai quella reale."""

import json
import os
import shlex
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "native_host"))
import install as installer


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="pillole-installer-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.home = self.root / "Home con spazi"
        self.home.mkdir()
        self.vault = self.root / "Vault con à e spazi"
        self.vault.mkdir()
        self.codex = self.root / "CLI con spazi" / "codex"
        self.codex.parent.mkdir()
        self.codex.write_text("#!/bin/sh\nexit 77\n", encoding="utf-8")
        self.codex.chmod(0o700)
        self.identifier = "a" * 32
        self.support = self.home / "Library" / "Application Support"
        self.config = self.support / "PilloleVault" / "config.json"
        self.manifest = self.support / "Microsoft Edge" / "NativeMessagingHosts" / "com.mattia.pillole_valut.json"

    def install(self, identifier=None, codex=None, force=False):
        return installer.install_host(
            identifier if identifier is not None else self.identifier,
            str(self.vault),
            codex_path=str(codex if codex is not None else self.codex),
            force=force,
            home=self.home,
        )

    def snapshot(self):
        return {str(path.relative_to(self.home)): path.read_bytes() for path in self.home.rglob("*") if path.is_file()}

    def test_writes_user_config_launcher_and_edge_manifest_only_in_temporary_home(self):
        with mock.patch("subprocess.Popen") as popen:
            self.install()
        popen.assert_not_called()
        config = json.loads(self.config.read_text(encoding="utf-8"))
        manifest = json.loads(self.manifest.read_text(encoding="utf-8"))
        self.assertEqual(config, {"version": 1, "vaultPath": str(self.vault.resolve()), "codexPath": str(self.codex.resolve())})
        self.assertEqual(manifest["name"], "com.mattia.pillole_valut")
        self.assertEqual(manifest["type"], "stdio")
        self.assertEqual(manifest["allowed_origins"], ["chrome-extension://" + self.identifier + "/"])
        self.assertNotIn("*", " ".join(manifest["allowed_origins"]))
        launcher = Path(manifest["path"])
        self.assertTrue(launcher.is_absolute())
        self.assertTrue(launcher.is_file())
        self.assertTrue(os.access(launcher, os.X_OK))
        self.assertIn(str(self.support / "PilloleVault"), str(launcher))
        # La lettura controlla presenza delle fonti, senza eseguire il launcher.
        self.assertIn("host.py", launcher.read_text(encoding="utf-8"))


    def test_installed_runtime_and_launcher_are_independent_of_source_location(self):
        sources = self.root / "Documents" / "Example project" / "native_host"
        sources.mkdir(parents=True)
        host_content = "# Test runtime fixture; never executed.\n"
        schema_content = '{"type": "object"}\n'
        (sources / "host.py").write_text(host_content, encoding="utf-8")
        (sources / "output-schema.json").write_text(schema_content, encoding="utf-8")
        with mock.patch.object(installer, "__file__", str(sources / "install.py")):
            result = self.install()
        sources.rename(sources.with_name("sources-moved"))
        self.assertEqual(result["hostPath"].read_text(encoding="utf-8"), host_content)
        self.assertEqual(result["schemaPath"].read_text(encoding="utf-8"), schema_content)
        self.assertEqual(result["hostPath"].parent, self.support / "PilloleVault")
        launcher = result["launcherPath"].read_text(encoding="utf-8")
        command = next(line for line in launcher.splitlines() if line.startswith("exec "))
        arguments = shlex.split(command)
        self.assertEqual(arguments[2], str(result["hostPath"]))
        self.assertNotIn(str(sources), launcher)
        self.assertIn("umask 077", launcher)
        self.assertIn(str(result["diagnosticPath"]), arguments)
        self.assertIn("2>", arguments)

    def test_existing_manifest_stops_registration_before_runtime_files_are_created(self):
        self.manifest.parent.mkdir(parents=True)
        self.manifest.write_text('{"existing": true}\n', encoding="utf-8")
        before = self.snapshot()
        with self.assertRaises(installer.InstallError):
            self.install()
        self.assertEqual(self.snapshot(), before)
        self.assertFalse((self.support / "PilloleVault" / "host.py").exists())

    def test_cli_symlink_remains_stable_across_versioned_binary_changes(self):
        link = self.root / "codex-stable"
        link.symlink_to(self.codex)
        installer.install_host(self.identifier, str(self.vault), codex_path=str(link), home=self.home)
        config = json.loads(self.config.read_text(encoding="utf-8"))
        self.assertEqual(config["codexPath"], str(link))

    def test_rerun_without_force_does_not_modify_existing_registration(self):
        self.install()
        before = self.snapshot()
        with self.assertRaises(Exception):
            self.install(identifier="b" * 32)
        self.assertEqual(self.snapshot(), before)

    def test_force_updates_registered_extension_without_touching_vault(self):
        self.install()
        note = self.vault / "Personale.md"
        note.write_text("Contenuto personale da preservare", encoding="utf-8")
        self.install(identifier="b" * 32, force=True)
        manifest = json.loads(self.manifest.read_text(encoding="utf-8"))
        self.assertEqual(manifest["allowed_origins"], ["chrome-extension://" + "b" * 32 + "/"])
        self.assertEqual(note.read_text(encoding="utf-8"), "Contenuto personale da preservare")

    def test_invalid_extension_ids_fail_before_creating_registration(self):
        for identifier in ["a" * 31, "a" * 33, "q" * 32, "../host", "", "A" * 32]:
            with self.subTest(identifier=identifier), self.assertRaises(Exception):
                self.install(identifier=identifier)
            self.assertFalse(self.support.exists())

    def test_missing_cli_fails_preflight_without_partial_installation(self):
        with self.assertRaises(Exception):
            self.install(codex=self.root / "cli-non-presente")
        self.assertFalse(self.support.exists())

    def test_missing_vault_fails_preflight_without_partial_installation(self):
        with self.assertRaises(Exception):
            installer.install_host(self.identifier, str(self.root / "vault-non-presente"), codex_path=str(self.codex), home=self.home)
        self.assertFalse(self.support.exists())


if __name__ == "__main__":
    unittest.main()
