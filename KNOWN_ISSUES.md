# Problemi noti — 0.1.x sperimentale

Questi rilievi sono stati confermati tramite revisione statica del codice, non riprodotti a runtime. Sono ancora aperti; pubblicare il repository non significa che l'applicazione sia stata collaudata. I test esistenti non sono ancora stati eseguiti.

## CLI-01 — Chiusura del ponte subito dopo l'avvio di Codex

In `native_host/host.py` esiste un intervallo tra l'avvio del processo figlio e la registrazione degli handler del ponte. Un SIGTERM in quell'intervallo può terminare il ponte prima che sia eseguito il cleanup del gruppo Codex. Il processo figlio può sopravvivere; una generazione effettivamente proseguita non è stata osservata.

Da fare: rendere sicuro anche questo intervallo e aggiungere una prova isolata del ciclo di vita, senza processi AI reali.

## B1 — Errore nello storico dopo una notifica riuscita

In `extension/worker.mjs` creazione della notifica e salvataggio dello storico condividono il ramo di errore. Se la notifica riesce ma il salvataggio fallisce, il recupero può rimettere la pillola in scorta e cancellarne il collegamento al dettaglio, mostrando un errore inesatto. Lo slot resta consumato, ma la pillola può essere riproposta in uno slot successivo.

Da fare: distinguere fallimenti dell'invio e della persistenza successiva, conservando il collegamento della notifica già creata.

## B2 — Rollback e nuove esclusioni

Se le esclusioni delle cartelle cambiano mentre l'API delle notifiche è in attesa e la notifica poi fallisce, il rollback può reintrodurre in scorta una fonte appena esclusa.

Da fare: applicare anche nel rollback i filtri correnti e coprire l'interleaving con un test.

## B3 — Catalogo nativo semanticamente non valido (percorso precedente)

Il worker controlla solo parte della struttura del catalogo. Una risposta con array notes e count intero ma metadata invalidi può essere accettata come catalogo vuoto e cancellare pillole valide prima della generazione successiva. Non è stato dimostrato che il ponte reale produca una simile risposta.

Il normale rifornimento costruisce ora il catalogo nel browser dalla cartella autorizzata e non usa questa risposta nativa. Il percorso precedente resta nel ponte per compatibilità; il nuovo flusso richiede comunque collaudo browser e test di regressione.

## B4 — Recupero di piano e mappa notifiche malformati

`extension/core/state.mjs` non normalizza completamente dailyPlan e i valori della mappa delle notifiche. Dati locali malformati possono provocare errori nello scheduler o nell'apertura della pillola. È un problema di robustezza del recupero; la produzione ordinaria di questi dati e un blocco permanente non sono stati dimostrati.

Da fare: validare il piano e la mappa nel caricamento dello stato e aggiungere test di recupero mirati.

## Collaudo ancora necessario

Dopo le correzioni: eseguire i test Python/JavaScript, verificare la compatibilità della CLI configurata e provare in Edge registrazione del ponte, generazione reale, notifica fuori fascia, apertura Obsidian, pausa e riavvio. La checklist pubblica descrive i passaggi.
