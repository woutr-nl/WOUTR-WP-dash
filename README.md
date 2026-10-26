# WOUTR-WP-dash

Webdashboard voor het beheren van WOUTR-klantsites. Het houdt per site de gegevens bij die de `WOUTR-WP`-commando's (`tools/deploy.sh`, `tools/update.sh`, `tools/live.sh`) als invoer nodig hebben. Geheimen (database- en SMTP-wachtwoord) worden versleuteld opgeslagen (AES-256-GCM).

Per site kan de beheerder vanuit de browser de drie `WOUTR-WP`-commando's starten (deployen, bijwerken/terugrollen, live gaan) en de geschiedenis van alle runs bekijken. Niemand heeft daarvoor een eigen SSH-sleutel, `gh`-login of de sitegegevens nodig.

De app bestaat uit een Node-app (Express) en een Postgres-database, samen in `docker-compose.yml`. Er is **geen `.env`-bestand**: alle instellingen en geheimen zijn omgevingsvariabelen.

## Omgevingsvariabelen

Ontbreekt een verplichte variabele of is die ongeldig, dan start de app niet. De log noemt dan alleen de naam van de variabele, nooit een waarde: `Ontbrekende of ongeldige omgevingsvariabele: <NAAM>`. Bij `docker compose` meldt compose zelf al welke variabele ontbreekt.

| Naam | Doel | Verplicht | Formaat |
|---|---|---|---|
| `ADMIN_USER` | Gebruikersnaam van het enige beheerdersaccount | ja | tekst |
| `ADMIN_PASSWORD` | Wachtwoord van het beheerdersaccount | ja | tekst; kies een lang, willekeurig wachtwoord |
| `SESSION_SECRET` | Ondertekent het login-cookie. Wijzigen logt iedereen uit | ja | minstens 32 tekens, bijv. `openssl rand -base64 32` |
| `ENCRYPTION_KEY` | Hoofdsleutel waarmee opgeslagen geheimen worden versleuteld. **Kwijt = opgeslagen wachtwoorden onleesbaar**; bewaar hem ook in de wachtwoordkluis. Niet wijzigen zolang er geheimen zijn opgeslagen | ja | base64 van precies 32 bytes: `openssl rand -base64 32` |
| `POSTGRES_PASSWORD` | Wachtwoord van de Postgres-database; de database én de app gebruiken het | ja | tekst. Wordt alleen bij de eerste start van een leeg volume ingesteld; later wijzigen vereist ook een wijziging in Postgres zelf |
| `SSH_PRIVATE_KEY` | SSH-sleutel waarmee de commando's inloggen op de hostingaccounts | ja | OpenSSH private key, zie hieronder |
| `GITHUB_TOKEN` | Token met leesrecht op `woutr-nl/WOUTR-WP`: de code (inclusief Git LFS) en de releases | ja | GitHub-token (fine-grained, alleen *Contents: read* op `woutr-nl/WOUTR-WP`) |
| `BRICKS_LICENSE_KEY` | Bricks-licentiesleutel, alleen doorgegeven bij het deployen van een Bricks-site | ja | tekst |
| `DASH_IMAGE_TAG` | Tag van de app-image die compose gebruikt, bijv. een commit-SHA om terug te rollen | nee, standaard `latest` | tekst (`latest` of een volledige commit-SHA) |
| `PORT` | Poort op de host waarop compose de app publiceert, alleen op `127.0.0.1` (in de container is het altijd 3000) | nee, standaard `3000` | getal |
| `PGHOST`, `PGPORT`, `PGUSER`, `PGDATABASE` | Alleen om de app buiten compose tegen een andere database te draaien | nee, standaard `db`, `5432`, `woutrdash`, `woutrdash` | tekst / getal |


### SSH-sleutel invullen

Plak de volledige inhoud van het sleutelbestand (bijv. `~/.ssh/id_ed25519`) **zoals hij is, met alle regels**, in het waardeveld van `SSH_PRIVATE_KEY` in Rollout, inclusief de regels `-----BEGIN OPENSSH PRIVATE KEY-----` en `-----END OPENSSH PRIVATE KEY-----`. Voeg geen aanhalingstekens toe.

Kan een veld geen meerdere regels bevatten, dan mag de sleutel ook op één regel met `\n` tussen de regels:

```sh
awk '{printf "%s\\n", $0}' ~/.ssh/id_ed25519
```

Gebruik een aparte sleutel zonder wachtwoordzin voor het dashboard, waarvan de publieke sleutel op de hostingaccounts staat.

## CI en images

GitHub Actions (`.github/workflows/ci.yml`) bouwt en test de app; Rollout bouwt zelf niets meer, maar haalt de kant-en-klare image op.

- **Pull request naar `main`**: `npm ci`, `npm test` en een build van de image uit de `Dockerfile`. Er wordt niets gepubliceerd.
- **Push/merge naar `main`**: dezelfde tests en build, daarna wordt de image gepubliceerd als `ghcr.io/woutr-nl/woutr-wp-dash` met twee tags: `latest` en de volledige commit-SHA (40 tekens) van die commit.
- Falen de tests, dan faalt de run en wordt er niets gebouwd of gepubliceerd.
- De image is alleen voor `linux/amd64`. Publiceren gebeurt met het eigen `GITHUB_TOKEN` van de workflow; er is geen persoonlijk token of extra secret nodig.
- Het package is privé en gekoppeld aan deze repository (zichtbaar onder *Packages* op de repositorypagina). Runs op `main` lopen na elkaar, zodat `latest` altijd naar de nieuwste commit wijst.

## Deployen op Rollout

1. Maak een GitHub-token **alleen om images te lezen**: een *classic* personal access token met uitsluitend de scope `read:packages` (fine-grained tokens werken nog niet voor het ophalen uit `ghcr.io`), van een account met leesrecht op de packages van `woutr-nl`. Vul in Rollout bij de registry-gegevens in: registry `ghcr.io`, je GitHub-gebruikersnaam en dat token als wachtwoord.
2. Maak in Rollout een **docker compose**-app aan op deze repository; Rollout gebruikt `docker-compose.yml` zoals hij is.
3. Stel in de UI van Rollout **alle verplichte variabelen** uit de tabel hierboven in. Maak geen `.env`-bestand aan en zet nooit geheimen in de repository.
4. Laat Rollout het domein en HTTPS regelen en verkeer doorsturen naar de app-service op poort **3000** (gewoon HTTP). De app vertrouwt de proxy (één hop) voor het client-IP en HTTPS, zodat het login-cookie `Secure` is. De app is op de host alleen via `127.0.0.1` bereikbaar (of via het compose-netwerk als `app:3000`), zodat niemand de proxy kan omzeilen en een vals client-IP kan meesturen.
5. Deploy. De databasetabellen worden bij het starten automatisch aangemaakt.
6. Controleer na de eerste publicatie eenmalig op de packagepagina (*Package settings*) dat de zichtbaarheid **Private** is.

**Nieuwe versie uitrollen**: een merge naar `main` publiceert een nieuwe `latest`, maar Rollout start die niet vanzelf. **Redeploy** de app in Rollout; die haalt `ghcr.io/woutr-nl/woutr-wp-dash:latest` opnieuw op en herstart de app. Handmatig op de server kan het ook: `docker compose pull && docker compose up -d`.

**Vastzetten of terugrollen**: zet in de variabelen van Rollout `DASH_IMAGE_TAG` op de volledige commit-SHA van een goede build (te vinden op de packagepagina van de repository of in de commitlijst van `main`) en redeploy. Verwijder de variabele en redeploy om terug te gaan naar `latest`.

Inloggen: na 5 mislukte pogingen vanaf één IP, of 30 in totaal, is inloggen 15 minuten geblokkeerd. Een sessie verloopt na 12 uur. **Uitloggen** maakt alle eerder uitgegeven login-cookies ongeldig, en een gewijzigd `ADMIN_PASSWORD` logt iedereen uit. Formulieren van een andere site (andere origin) worden geweigerd.

De databasegegevens staan in het benoemde volume `dbdata`; ze blijven bewaard bij herstarten en opnieuw deployen. Verwijder dat volume niet.

Het volume `appdata` (`/data` in de container) bevat de checkout van `WOUTR-WP` en de onthouden SSH-hostsleutels (`/data/ssh/known_hosts`). Verwijder ook dat volume niet: zonder die hostsleutels wordt bij de volgende verbinding elke server opnieuw blind vertrouwd.

## Runs: deployen, bijwerken en live gaan

Op de pagina **Runs** van een site staan de knoppen **Deployen**, **Bijwerken** en **Live gaan**, het gegenereerde beheerderswachtwoord (knop **Toon**) en de geschiedenis van alle runs, nieuwste eerst. Het siteoverzicht toont per site de laatste run.

- Het dashboard voert de **echte commando's** uit (`tools/deploy.sh`, `tools/update.sh`, `tools/live.sh`) uit een checkout van `woutr-nl/WOUTR-WP`, die vóór elke run wordt bijgewerkt naar de huidige `main`. Een wijziging die daar wordt gemerged, wordt dus meteen gebruikt. Voor een Bricks-deploy wordt ook de Bricks-zip uit Git LFS opgehaald.
- **Deployen**: kies optioneel een release van het child-thema en (blokthema) van `woutr`, of laat ze op *nieuwste*. SMTP wordt meegestuurd als de site dat heeft. Staat er al een site met inhoud (exitcode 3), dan stopt de run; het log laat zien wat er staat. Pas na een expliciete bevestiging dat de site **gewist** wordt, start een nieuwe run met `--overwrite`. Het gegenereerde beheerderswachtwoord wordt versleuteld bij de site opgeslagen.
- **Bijwerken**: kies de versies uit de releases van de slug. Een oudere versie dan geïnstalleerd wordt vooraf als **terugrol** gemarkeerd. SMTP wordt alleen opnieuw toegepast als je dat aanvinkt.
- **Live gaan**: toont per controle (`check_https`, `check_debug`, `check_smtp`) geslaagd, mislukt of niet gecontroleerd. Mislukt er een (exitcode 3), dan blijft de indexering uit; alleen via **Toch live gaan** (met bevestiging) volgt een run met `--force`.
- Per site loopt maximaal één run tegelijk; een tweede wordt geweigerd. Een site met een lopende run kan niet worden verwijderd.
- Het log (stderr van het commando) is tijdens de run live te volgen. Een run die werd afgebroken, bijvoorbeeld door een herstart van het dashboard, staat daarna als **onderbroken**.
- Elke run bewaart actie, keuzes, start- en eindtijd, uitkomst, exitcode, het `key=value`-resultaat en het volledige log.

**Geheimen** gaan alleen via omgevingsvariabelen naar de commando's (`WP_DB_PASS`, `WOUTR_SMTP_PASS`, `BRICKS_LICENSE_KEY`, `GH_TOKEN`), nooit als argument. De commando's krijgen geen andere variabelen van het dashboard mee. Alle geheimen (database-, SMTP- en Bricks-wachtwoord, SSH-sleutel, GitHub-token en het gegenereerde beheerderswachtwoord) worden in log en resultaat vervangen door `[geheim]`; het beheerderswachtwoord staat alleen versleuteld bij de site.

**SSH-hostsleutels**: bij de eerste verbinding met een server wordt diens hostsleutel vertrouwd en onthouden. Verandert die sleutel later, dan weigert SSH te verbinden en mislukt de run met een duidelijke melding. Klopt de nieuwe sleutel (bijv. na een serververhuizing), verwijder dan de oude regel van die host uit `/data/ssh/known_hosts` in de container: `docker compose exec app ssh-keygen -R <host> -f /data/ssh/known_hosts`.

## Lokaal draaien

Met Docker en compose, vanuit de lokale broncode en zonder in te loggen bij `ghcr.io`. Bouw eerst zelf de image met de tag `local` en laat compose die gebruiken; omdat de image lokaal bestaat, haalt compose niets op. De variabelen worden geëxporteerd in de shell (geen `.env`):

```sh
docker build -t ghcr.io/woutr-nl/woutr-wp-dash:local .
export DASH_IMAGE_TAG=local
export ADMIN_USER=admin
export ADMIN_PASSWORD='kies-een-wachtwoord'
export SESSION_SECRET="$(openssl rand -base64 32)"
export ENCRYPTION_KEY="$(openssl rand -base64 32)"
export POSTGRES_PASSWORD='lokaal-db-wachtwoord'
export SSH_PRIVATE_KEY=dummy GITHUB_TOKEN=dummy BRICKS_LICENSE_KEY=dummy
docker compose up
```

Na een wijziging in de code: opnieuw `docker build …` en `docker compose up`. Open daarna <http://localhost:3000>. Met dummywaarden voor `SSH_PRIVATE_KEY`, `GITHUB_TOKEN` en `BRICKS_LICENSE_KEY` werkt het beheer van sites, maar mislukken runs. `POSTGRES_PASSWORD` is hier bewust een vaste waarde: Postgres stelt het wachtwoord alleen in bij de eerste start van een leeg volume, dus een ander wachtwoord bij een volgende start geeft `password authentication failed` en een app die blijft herstarten. Wil je het wachtwoord wijzigen, wis dan eerst de lokale database met `docker compose down -v`. Bewaar ook `ENCRYPTION_KEY` als je dezelfde database opnieuw wilt gebruiken, anders zijn de opgeslagen wachtwoorden onleesbaar.

## Beveiliging

- Eén beheerder, geen registratie. Alles behalve de loginpagina vereist inloggen.
- Na 5 mislukte inlogpogingen binnen 15 minuten wordt dat IP-adres 15 minuten geblokkeerd; elke mislukte poging wordt bovendien vertraagd.
- Opgeslagen wachtwoorden worden nooit in formulieren getoond. Alleen de knop **Toon** haalt de ontsleutelde waarde op.
- Waarden die de commando's als optie zouden lezen (beginnend met `-`) of verkeerd zouden lezen (regeleindes, een SSH-doel dat geen `gebruiker@host` is, een URL zonder http(s)) worden geweigerd. SMTP-instellingen kunnen alleen bij een blokthema.

## Tests

```sh
npm ci
npm test
```
