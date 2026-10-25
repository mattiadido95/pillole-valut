# Checklist manuale — pillole-valut

**Stato**: da eseguire dall'utente. Nessuna prova browser, CLI, installazione, build o test automatico è stata eseguita dall'agente durante l'implementazione.

Prerequisiti: Edge/Chromium120+, Python3.9+, Codex CLI con login funzionante, Obsidian con il vault aperto. Percorso di lavoro la directory in cui hai clonato il repository. I dati finti restano nei test; l'app genera solo da note reali.

## Checkpoint 1 — Installazione e collegamento

1. Carica `extension/` decompressa in Edge. Atteso: scheda estensione senza errori di manifest e ID disponibile.
2. Esegui il comando di registrazione in README con l'ID corretto. Atteso: configurazione e launcher nel profilo utente, nessun sudo o pacchetto installato.
3. Apri popup e pagina di gestione. Atteso: UI leggibile, scorta vuota, routine disabilitata, fasce e quantità iniziali corrette.
4. Controlla il ponte. Atteso: vault e Codex accessibili; nessuna generazione eseguita da questo solo controllo.
5. Prima della registrazione, oppure con ID di un'altra estensione, il controllo deve dare un errore comprensibile. Il caricamento delle pagine deve continuare a funzionare.

## Checkpoint 2 — Prima pillola e prova fuori fascia

1. Prepara la scorta con CLI autenticata. Atteso: avanzamento visibile, batch limitati, pillole reali in italiano con fonte. Più clic durante la preparazione non avviano richieste duplicate.
2. Apri una pillola. Atteso: titolo, spiegazione, eventuale esempio e nota sorgente leggibili. Caratteri Markdown o HTML della nota sono testo e non eseguono codice.
3. Apri la fonte in Obsidian. Atteso: stessa nota con spazi e accenti nel nome; le note del vault non vengono modificate.
4. Con routine ancora disabilitata, invia una prova di sera o nel weekend. Atteso: notifica e dettaglio al clic; scorta e quota automatica non consumate.
5. Prova a inviare con scorta vuota. Atteso: invito a prepararla, nessuna generazione implicita.
6. Nega le notifiche in macOS/Edge e riprova. Atteso: errore quando il browser lo segnala, interfaccia utilizzabile; nessun contenuto perso per un errore API. Focus può sopprimere il banner senza segnalare un errore al browser.

## Routine e regressioni

1. Abilita la routine. Atteso: quattro slot del giorno feriale, due in ciascuna fascia, fuso Europe/Rome; gli slot già passati non sono recuperati.
2. Riapri popup o riavvia il worker. Atteso: stessi slot e stessa scorta, nessuna nuova casualizzazione o duplicazione.
3. Pausa la routine. Atteso: nessuna notifica automatica e nessun nuovo refill automatico; un batch già iniziato può terminare. La prova manuale continua a funzionare.
4. Riattiva dopo uno slot o dopo una sospensione lunga. Atteso: nessuna raffica o recupero di slot vecchi; eventuali invii futuri rispettano le fasce.
5. Cambia impostazioni nello stesso giorno. Atteso: quota già consumata conservata; nessun reset per ottenere nuovi invii degli stessi slot.
6. Riduci/espandi le finestre con valori validi. Atteso: pianificazione aggiornata. Fasce sovrapposte, orari non validi o numero troppo alto rispetto alla durata devono essere rifiutati senza cancellare le impostazioni precedenti.
7. Lascia scendere la scorta a quattro. Atteso: refill unico e limitato; le note in coda e quelle mostrate di recente non vengono duplicate.
8. Rendi temporaneamente indisponibile la CLI dal percorso configurato senza eliminare file personali, oppure prova con una configurazione di test separata. Atteso: errore visibile e backoff, scorta preesistente ancora consultabile. Evitare di modificare token o configurazioni personali per simulare errori.
9. Per i casi limite di weekend, DST, slot scaduti, framing e symlink usa i test isolati descritti in README, senza cambiare l'orologio del Mac o le note personali.

## Comandi di verifica

Dalla root progetto:

```sh
python3 -m unittest discover -s tests -p 'test_*.py' -v
```

Atteso `OK`: bridge e installer in isolamento con processi simulati. Nessuna chiamata AI reale.

```sh
node --test tests/schedule.test.mjs tests/state.test.mjs tests/vault.test.mjs
```

Atteso zero failure: scheduler e fuso orario. Richiede un Node18+ già disponibile.

Non è prevista una build: caricare direttamente `extension/`. Per diagnosticare l'integrazione, nella scheda `edge://extensions` leggere gli errori e aprire il service worker; non incollare token o testi privati nei report.

## Raccolta degli esiti

Per ogni comando riporta esito, output rilevante, data e versione runtime. Per la prova UI riporta passaggio, azione, risultato e differenza osservata. Se un controllo pertinente non è eseguito, il checkpoint resta PARZIALE. L'assenza di errori in console non dimostra da sola tutti i requisiti.

## Collegamento del vault nel browser

Dopo Controlla il ponte, scegliere Collega il vault e selezionare la cartella configurata. Atteso un conteggio delle note leggibili, nessuna chiamata Codex dal solo collegamento e nessuna scrittura nelle note. La preparazione deve usare il batch fornito da Edge senza catalogare la cartella attraverso Python. Revocare il consenso o annullare il picker deve lasciare la scorta esistente; dopo una revoca, ricollegare la cartella. Verificare anche ripresa dopo ricarica e apertura della fonte corretta in Obsidian.

`tests/vault.test.mjs` prepara controlli su filtri, hash, handle autorizzati, rifiuti e selezione batch; i casi BrowserInputTests in test_host.py controllano che la generazione da browser non enumeri il vault. Test e UI non sono stati eseguiti dall'agente.
