"""Test contrattuali del ponte: nessun processo Codex o dato personale reale."""

import io
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "native_host"))
import host


class FragmentedReader(io.BytesIO):
    """Riproduce pipe che consegnano meno byte della read richiesta."""

    def read(self, size=-1):
        return super().read(min(size, 3) if size >= 0 else 3)


class FramingTests(unittest.TestCase):
    def test_unicode_uses_utf8_byte_length_and_round_trips(self):
        value = {"id": "é", "action": "status", "payload": {}, "text": "📚 nozioni"}
        stream = io.BytesIO()
        host.write_message(stream, value)
        raw = stream.getvalue()
        self.assertEqual(struct.unpack("=I", raw[:4])[0], len(raw[4:]))
        self.assertEqual(host.read_message(FragmentedReader(raw)), value)

    def test_multiple_messages_are_not_merged(self):
        stream = io.BytesIO()
        first = {"id": "uno", "action": "status", "payload": {}}
        second = {"id": "due", "action": "catalog", "payload": {}}
        host.write_message(stream, first)
        host.write_message(stream, second)
        stream.seek(0)
        self.assertEqual(host.read_message(stream), first)
        self.assertEqual(host.read_message(stream), second)
        self.assertIsNone(host.read_message(stream))

    def test_clean_eof_is_not_an_error(self):
        self.assertIsNone(host.read_message(io.BytesIO()))

    def test_truncated_headers_and_payloads_are_rejected(self):
        for raw in [b"\x01\x00", struct.pack("=I", 20) + b"{}"]:
            with self.subTest(raw=raw), self.assertRaises(host.HostError):
                host.read_message(FragmentedReader(raw))

    def test_oversized_frame_is_rejected_before_payload_read(self):
        with self.assertRaises(host.HostError):
            host.read_message(io.BytesIO(struct.pack("=I", 1024 * 1024 + 1)))

    def test_invalid_json_or_utf8_is_rejected(self):
        for body in [b"not-json", b"\xff"]:
            with self.subTest(body=body), self.assertRaises(host.HostError):
                host.read_message(io.BytesIO(struct.pack("=I", len(body)) + body))


    def test_non_object_json_is_not_confused_with_clean_eof(self):
        for value in [None, [], "text", 1]:
            body = json.dumps(value).encode("utf-8")
            with self.subTest(value=value), self.assertRaises(host.HostError):
                host.read_message(io.BytesIO(struct.pack("=I", len(body)) + body))

    def test_oversized_response_is_not_written(self):
        stream = io.BytesIO()
        with self.assertRaises(host.HostError):
            host.write_message(stream, {"text": "x" * (1024 * 1024)})
        self.assertEqual(stream.getvalue(), b"")


class VaultFixture(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="pillole-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.vault = self.root / "Vault con spazi"
        self.vault.mkdir()
        self.codex = self.root / "bin" / "codex"
        self.codex.parent.mkdir()
        # Questo file non viene eseguito: generate usa sempre il mock _run_codex.
        self.codex.write_text("#!/bin/sh\nexit 77\n", encoding="utf-8")
        self.codex.chmod(0o700)
        self.config = {"version": 1, "vaultPath": str(self.vault), "codexPath": str(self.codex)}

    def note(self, relative="Concetti/Nota.md", title="Una nozione", text=None):
        path = self.vault / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        body = text if text is not None else (
            "# " + title + "\n\n" +
            "Un concetto riutilizzabile aiuta a capire il comportamento di un sistema. " * 4
        )
        path.write_text(body, encoding="utf-8")
        return path

    def request(self, action, payload=None):
        return host.process_request({"id": "request-1", "action": action, "payload": payload or {}}, self.config)


class CatalogTests(VaultFixture):
    def test_catalog_metadata_has_no_note_body_and_keeps_relative_source(self):
        self.note("Concetti/Nota.md", "Titolo dalla nota")
        response = self.request("catalog")
        self.assertTrue(response["ok"])
        result = response["result"]
        self.assertEqual(result["count"], 1)
        note = result["notes"][0]
        self.assertEqual(set(note), {"id", "title", "path", "hash", "modifiedAt"})
        self.assertEqual(note["path"], "Concetti/Nota.md")
        self.assertEqual(note["title"], "Titolo dalla nota")
        self.assertEqual(len(note["hash"]), 64)
        self.assertNotIn("_body", note)

    def test_catalog_filters_hidden_templates_moc_short_and_large_notes(self):
        self.note("Concetti/Valida.md")
        self.note(".private/Segreto.md")
        self.note("Concetti/.nascosta.md")
        self.note("Concetti/_Template Concetto.md")
        self.note("Concetti/00 - MOC Concetti.md")
        self.note("Concetti/Breve.md", text="Troppo breve")
        self.note("Concetti/Grande.md", text="a" * (201 * 1024))
        self.note("Concetti/Solo frontmatter.md", text="---\ncomment: " + "x" * 200 + "\n---\n")
        paths = {item["path"] for item in host.list_notes(self.config)}
        self.assertEqual(paths, {"Concetti/Valida.md"})

    def test_folder_exclusion_does_not_remove_similarly_named_sibling(self):
        self.note("Tech News/Notizia.md")
        self.note("Tech News extra/Concetto.md")
        notes = host.list_notes(self.config, exclude_folders=["Tech News"])
        self.assertEqual({item["path"] for item in notes}, {"Tech News extra/Concetto.md"})

    def test_note_ids_are_stable_and_hash_changes_when_content_changes(self):
        source = self.note()
        before = host.list_notes(self.config)[0]
        source.write_text(source.read_text(encoding="utf-8") + "Nuovo contenuto importante.\n", encoding="utf-8")
        after = host.list_notes(self.config)[0]
        self.assertEqual(before["id"], after["id"])
        self.assertNotEqual(before["hash"], after["hash"])

    def test_note_ids_can_be_excluded_without_recent_note_fallback(self):
        self.note()
        identity = host.list_notes(self.config)[0]["id"]
        self.assertEqual(host.list_notes(self.config, exclude_ids=[identity]), [])

    def test_file_and_directory_symlinks_outside_vault_are_ignored(self):
        external_dir = self.root / "outside"
        external_dir.mkdir()
        external = external_dir / "outside.md"
        external.write_text("# Privato\n" + "Contenuto esterno da non leggere. " * 10, encoding="utf-8")
        self.note("Dentro.md")
        (self.vault / "Link.md").symlink_to(external)
        (self.vault / "Link directory").symlink_to(external_dir, target_is_directory=True)
        self.assertEqual({item["path"] for item in host.list_notes(self.config)}, {"Dentro.md"})

    def test_invalid_utf8_note_is_skipped(self):
        self.note("Dentro.md")
        (self.vault / "Invalida.md").write_bytes(b"\xff" * 120)
        self.assertEqual({item["path"] for item in host.list_notes(self.config)}, {"Dentro.md"})

    def test_frontmatter_is_not_sent_as_note_body(self):
        self.note("Front.md", text="---\nsecret: Non inviare metadati\n---\n# Titolo\n" + "Corpo del concetto. " * 10)
        note = host.list_notes(self.config)[0]
        self.assertNotIn("Non inviare metadati", note["_body"])
        self.assertIn("Corpo del concetto", note["_body"])


class RequestValidationTests(VaultFixture):
    def test_status_uses_files_only_and_never_starts_cli(self):
        with mock.patch.object(host.subprocess, "Popen") as popen:
            response = self.request("status")
        popen.assert_not_called()
        self.assertTrue(response["ok"])
        self.assertEqual(response["id"], "request-1")
        self.assertEqual(response["result"]["version"], 1)
        self.assertTrue(response["result"]["vaultAvailable"])
        self.assertTrue(response["result"]["codexAvailable"])

    def test_unknown_action_is_not_a_command_execution(self):
        with mock.patch.object(host.subprocess, "Popen") as popen:
            response = self.request("run_shell", {"command": "echo unsafe"})
        popen.assert_not_called()
        self.assertFalse(response["ok"])
        self.assertEqual(response["error"]["code"], "UNKNOWN_ACTION")

    def test_invalid_batch_sizes_and_types_are_rejected_before_cli(self):
        self.note()
        for count in [0, 5, -1, 1.5, True, "2"]:
            with self.subTest(count=count), mock.patch.object(host, "_run_codex") as runner:
                response = self.request("generate", {"count": count})
                runner.assert_not_called()
                self.assertFalse(response["ok"])
                self.assertEqual(response["error"]["code"], "INVALID_REQUEST")

    def test_traversal_absolute_paths_and_exclusion_overflow_are_rejected(self):
        payloads = [
            {"excludeFolders": ["../Private"]},
            {"excludeFolders": ["/tmp/Private"]},
            {"excludeFolders": ["A/../../Private"]},
            {"excludeFolders": ["x"] * 101},
        ]
        for payload in payloads:
            with self.subTest(payload=payload):
                response = self.request("catalog", payload)
                self.assertFalse(response["ok"])
                self.assertEqual(response["error"]["code"], "INVALID_REQUEST")
        response = self.request("generate", {"count": 1, "excludeNoteIds": ["x"] * 501})
        self.assertFalse(response["ok"])
        self.assertEqual(response["error"]["code"], "INVALID_REQUEST")

    def test_unavailable_vault_returns_controlled_error(self):
        self.config["vaultPath"] = str(self.root / "Non esiste")
        response = self.request("catalog")
        self.assertFalse(response["ok"])
        self.assertEqual(response["error"]["code"], "VAULT_UNAVAILABLE")


class GenerationTests(VaultFixture):
    def setUp(self):
        super().setUp()
        self.source = self.note("Concetti/Nota con à & spazi.md", "Fonte reale")
        self.source_note = host.list_notes(self.config)[0]

    def model_pill(self, **overrides):
        result = {
            "sourceId": self.source_note["id"],
            "title": "Il concetto in breve",
            "summary": "Questa spiegazione illustra un concetto presente nella nota sorgente.",
            "example": "Un piccolo esempio riutilizzabile.",
        }
        result.update(overrides)
        return result

    def test_generate_adds_trusted_metadata_and_never_modifies_source(self):
        original = self.source.read_bytes()
        response = {"pills": [self.model_pill()]}
        with mock.patch.object(host, "_run_codex", return_value=response) as runner:
            result = host.generate_pills(self.config, count=1)
        runner.assert_called_once()
        pill = result["pills"][0]
        self.assertEqual(set(pill), {
            "id", "sourceId", "sourcePath", "sourceTitle", "sourceHash", "sourceUrl",
            "title", "summary", "example", "createdAt",
        })
        self.assertEqual(pill["sourceId"], self.source_note["id"])
        self.assertEqual(pill["sourceHash"], self.source_note["hash"])
        self.assertEqual(pill["sourceTitle"], "Fonte reale")
        self.assertEqual(pill["sourcePath"], "Concetti/Nota con à & spazi.md")
        parsed = urlparse(pill["sourceUrl"])
        self.assertEqual(parsed.scheme, "obsidian")
        self.assertEqual(parsed.netloc, "open")
        self.assertEqual(parse_qs(parsed.query)["path"], [str(self.source.resolve())])
        self.assertEqual(self.source.read_bytes(), original)
        self.assertTrue(pill["id"])
        self.assertTrue(pill["createdAt"])

    def test_smaller_batch_when_fewer_sources_are_available(self):
        with mock.patch.object(host, "_run_codex", return_value={"pills": [self.model_pill()]}):
            result = host.generate_pills(self.config, count=4)
        self.assertEqual(len(result["pills"]), 1)

    def test_excluding_all_sources_returns_no_notes_without_cli(self):
        with mock.patch.object(host, "_run_codex") as runner:
            with self.assertRaises(host.HostError) as raised:
                host.generate_pills(self.config, count=1, exclude_ids=[self.source_note["id"]])
        self.assertEqual(raised.exception.code, "NO_NOTES")
        runner.assert_not_called()

    def test_untrusted_unknown_or_duplicate_source_is_rejected(self):
        cases = [
            {"pills": [self.model_pill(sourceId="inventato")]},
            {"pills": [self.model_pill(), self.model_pill()]},
            {"pills": []},
        ]
        for raw in cases:
            with self.subTest(raw=raw), self.assertRaises(host.HostError) as raised:
                host._validate_generated_output(raw, [self.source_note])
            self.assertEqual(raised.exception.code, "INVALID_OUTPUT")

    def test_model_text_has_deterministic_length_and_type_limits(self):
        bad_fields = [
            {"title": ""}, {"title": "x" * 121}, {"title": []},
            {"summary": ""}, {"summary": "x" * 1601}, {"summary": None},
            {"example": "x" * 1001}, {"example": 42},
        ]
        for override in bad_fields:
            with self.subTest(override=override), self.assertRaises(host.HostError) as raised:
                host._validate_generated_output({"pills": [self.model_pill(**override)]}, [self.source_note])
            self.assertEqual(raised.exception.code, "INVALID_OUTPUT")

    def test_cli_failure_does_not_leak_raw_stderr_to_response(self):
        with mock.patch.object(host, "_run_codex", side_effect=RuntimeError("PRIVATE-RAW-CONTENT")):
            response = self.request("generate", {"count": 1})
        self.assertFalse(response["ok"])
        self.assertEqual(response["error"]["code"], "INTERNAL_ERROR")
        self.assertNotIn("PRIVATE-RAW-CONTENT", json.dumps(response))


class CliBoundaryTests(VaultFixture):
    def setUp(self):
        super().setUp()
        self.note()
        self.notes = host.list_notes(self.config)
        self.signal_patch = mock.patch.object(host.signal, "signal", return_value=host.signal.SIG_DFL)
        self.signal_patch.start()
        self.addCleanup(self.signal_patch.stop)

    def fake_success(self, content):
        calls = {}

        def launch(argv, **kwargs):
            calls["argv"] = argv
            calls["kwargs"] = kwargs
            process = mock.Mock()
            process.returncode = 0
            process.pid = 12345

            def communicate(input=None, timeout=None):
                calls["input"] = input
                calls["timeout"] = timeout
                target = Path(argv[argv.index("--output-last-message") + 1])
                target.write_bytes(content)
                return (None, None)

            process.communicate.side_effect = communicate
            return process

        return calls, launch

    def test_cli_uses_argv_stdin_readonly_schema_temporary_cwd_and_bounded_logs(self):
        raw = {"pills": [{"sourceId": self.notes[0]["id"], "title": "Titolo", "summary": "Spiegazione", "example": ""}]}
        calls, launch = self.fake_success(json.dumps(raw).encode("utf-8"))
        with mock.patch.object(host.subprocess, "Popen", side_effect=launch):
            self.assertEqual(host._run_codex(self.config, self.notes), raw)
        argv = calls["argv"]
        self.assertEqual(argv[0], str(self.codex))
        self.assertEqual(argv[argv.index("--ask-for-approval") + 1], "never")
        self.assertEqual(argv[argv.index("--sandbox") + 1], "read-only")
        self.assertIn("--skip-git-repo-check", argv)
        self.assertIn("--ephemeral", argv)
        self.assertTrue(Path(argv[argv.index("--output-schema") + 1]).is_absolute())
        self.assertEqual(argv[-1], "-")
        self.assertFalse(calls["kwargs"]["shell"])
        self.assertTrue(calls["kwargs"]["start_new_session"])
        self.assertNotEqual(calls["kwargs"]["cwd"], str(self.vault))
        self.assertEqual(calls["timeout"], 240)
        self.assertIsInstance(calls["input"], bytes)
        self.assertIn(self.notes[0]["id"].encode("utf-8"), calls["input"])
        self.assertNotEqual(calls["kwargs"]["stdout"], subprocess.PIPE)
        self.assertNotEqual(calls["kwargs"]["stderr"], subprocess.PIPE)

    def test_timeout_terminates_child_process_group_without_real_process(self):
        process = mock.Mock()
        process.pid = 12345
        process.communicate.side_effect = [subprocess.TimeoutExpired("codex", 240), (None, None)]
        with mock.patch.object(host.subprocess, "Popen", return_value=process), mock.patch.object(host.os, "killpg") as kill:
            with self.assertRaises(host.HostError) as raised:
                host._run_codex(self.config, self.notes)
        self.assertEqual(raised.exception.code, "CODEX_TIMEOUT")
        kill.assert_called_once_with(12345, host.signal.SIGKILL)
        self.assertEqual(process.communicate.call_count, 2)


    def test_host_shutdown_terminates_child_and_restores_signal_handlers(self):
        handlers = {}
        process = mock.Mock()
        process.pid = 12345
        process.returncode = 0

        def register(signum, handler):
            if callable(handler):
                handlers[signum] = handler
            return host.signal.SIG_DFL

        calls = 0

        def communicate(input=None, timeout=None):
            nonlocal calls
            calls += 1
            if calls == 1:
                handlers[host.signal.SIGTERM](host.signal.SIGTERM, None)
            return (None, None)

        process.communicate.side_effect = communicate
        with mock.patch.object(host.signal, "signal", side_effect=register) as signal_registration, mock.patch.object(host.subprocess, "Popen", return_value=process), mock.patch.object(host.os, "killpg") as kill:
            with self.assertRaises(SystemExit) as raised:
                host._run_codex(self.config, self.notes)
        self.assertEqual(raised.exception.code, 128 + host.signal.SIGTERM)
        kill.assert_called_once_with(12345, host.signal.SIGKILL)
        self.assertEqual(calls, 2)
        self.assertEqual(signal_registration.call_count, 4)
        self.assertIn(mock.call(host.signal.SIGTERM, host.signal.SIG_DFL), signal_registration.call_args_list)
        self.assertIn(mock.call(host.signal.SIGINT, host.signal.SIG_DFL), signal_registration.call_args_list)

    def test_nonzero_exit_is_a_safe_error_without_stderr_leak(self):
        process = mock.Mock()
        process.returncode = 2
        process.communicate.return_value = (b"PRIVATE-STDOUT", b"PRIVATE-STDERR")
        with mock.patch.object(host.subprocess, "Popen", return_value=process):
            with self.assertRaises(host.HostError) as raised:
                host._run_codex(self.config, self.notes)
        self.assertEqual(raised.exception.code, "CODEX_FAILED")
        self.assertNotIn("PRIVATE", str(raised.exception))

    def test_empty_invalid_or_oversized_final_output_is_rejected(self):
        for content in [b"", b"not json", b"x" * (128 * 1024 + 1)]:
            calls, launch = self.fake_success(content)
            with self.subTest(size=len(content)), mock.patch.object(host.subprocess, "Popen", side_effect=launch):
                with self.assertRaises(host.HostError) as raised:
                    host._run_codex(self.config, self.notes)
                self.assertEqual(raised.exception.code, "INVALID_OUTPUT")


if __name__ == "__main__":
    unittest.main()
