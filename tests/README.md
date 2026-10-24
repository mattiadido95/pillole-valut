# Verifiche preparate — pillole-valut

Questi test sono stati scritti ma **non eseguiti**. Il lavoro di questo sviluppo non comprende autorizzazione a lanciare test, build, lint, CLI reali o app. Le prove sono a carico dell'utente. La revisione del codice per lettura non dimostra che sintassi o comportamento runtime siano corretti.

## Esecuzione manuale dei test automatici

Directory per tutti i comandi: la directory in cui hai clonato il repository.

```sh
python3 -m unittest discover -s tests -p 'test_*.py' -v
```

Richiede Python 3.9+ già disponibile. Usa soltanto unittest e libreria standard. Prova framing Native Messaging, validazione delle richieste, filtri e symlink, fonti e output modello, confine del processo CLI e registrazione in una home temporanea. La CLI è sostituita da mock; non usa l'account Codex né modifica il vault reale o la registrazione host del Mac. Risultato atteso: casi con `ok` e riepilogo `OK`. `ERROR` indica un problema di import/esecuzione o un'eccezione inattesa; `FAIL` una differenza dal contratto da leggere nel traceback.

```sh
node --test tests/schedule.test.mjs tests/state.test.mjs
```

Usare un Node18+ già disponibile nel PATH. Non servono dipendenze npm. Richiede Node 18+ con node:test e structuredClone. Verifica orari, quote, ritardi, DST e mutazioni persistenti concorrenti, simulando soltanto storage.local. Risultato atteso: zero test falliti; errori di import indicano file/runtime da controllare, differenze di assertion indicano una regressione rispetto al contratto.

## Copertura

| Area | Requisiti | File | Cosa resta manuale |
| --- | --- | --- | --- |
| Vault e protocollo | R1, R7, R9 | test_host.py | Permessi reali macOS/Edge e vault scelto |
| Generazione e fonti | R2, R8 | test_host.py | Login, quota, compatibilità CLI e qualità della sintesi reale |
| Registrazione host | R7 | test_install.py | Registrazione utente e collegamento con l'ID Edge reale |
| Scheduler | R4, R6 | schedule.test.mjs | Allarmi Edge dopo riavvio/sospensione e precisione del sistema |
| Stato persistente | R3, R9 | state.test.mjs | Concorrenza worker/refill e flusso completo delle notifiche |
| Prova e lettura | R5, R8 | checklist manuale | Notifica sera/weekend, dettaglio e apertura Obsidian |

## Checklist manuale sintetica

1. Caricare `extension/` da `edge://extensions` in modalità sviluppatore. Atteso: nessun errore di manifest e automazione inizialmente disabilitata.
2. Copiare l'ID e registrare l'host con il comando documentato in README.md, senza sudo. Atteso: ID corretto e solo tre file applicativi utente creati.
3. Aprire la pagina dell'estensione e controllare il ponte. Atteso: vault e CLI individuati; questo non certifica il login.
4. Preparare la scorta. Atteso: pillole basate su note reali, sorgente coerente, nessun contenuto demo, errori comprensibili se login/limiti impediscono la generazione.
5. Inviare una prova anche sabato/sera. Atteso: una notifica con dettaglio al clic; scorta e quota automatica non consumate. Ripetere con permessi notifiche negati: errore visibile, nessuna perdita della scorta.
6. Dalla scheda aprire Obsidian. Atteso: esatta nota sorgente, inclusi percorsi con spazi e caratteri accentati.
7. Abilitare gli invii: atteso lun–ven, due per ogni fascia concordata. Le prove automatiche nelle fasce vanno fatte in un giorno feriale; la prova manuale non dimostra lo scheduler.
8. Riavviare Edge o riprendere il Mac dopo uno slot scaduto. Atteso: nessuna raffica di recuperi e nessun reset della quota già consumata.
9. Mettere in pausa e modificare le finestre/quantità. Atteso: nessun invio in pausa, slot passati non recuperati, quota del giorno non azzerata.
10. Rendere temporaneamente indisponibile il ponte/vault prima del refill. Atteso: contenuti già salvati conservati; errore e attesa per retry automatico, senza generazioni ripetute in loop.

Non cambiare l'orologio di sistema per queste prove: le funzioni pure consentono di verificare DST e date fisse nei test. Focus/macOS può nascondere una notifica che Edge dichiara creata; controllare anche il Centro Notifiche.
