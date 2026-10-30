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
| `ENCRYPTION_KEY` | Hoofdsleutel waarmee opgeslagen geheimen worden versleuteld. **Kwijt = opgeslagen wachtwoorden én de SSH-sleutel van het dashboard onleesbaar**; bewaar hem ook in de wachtwoordkluis. Niet wijzigen zolang er geheimen zijn opgeslagen | ja | base64 van precies 32 bytes: `openssl rand -base64 32` |
| `POSTGRES_PASSWORD` | Wachtwoord van de Postgres-database; de database én de app gebruiken het | ja | tekst. Wordt alleen bij de eerste start van een leeg volume ingesteld; later wijzigen vereist ook een wijziging in Postgres zelf |
| `SSH_PRIVATE_KEY` | Alleen voor de eenmalige overname van een bestaande sleutel bij een upgrade; daarna genegeerd en te verwijderen | nee | OpenSSH private key zonder wachtwoordzin, zie *SSH-sleutel* |
| `GITHUB_TOKEN` | Token met leesrecht op `woutr-nl/WOUTR-WP`: de code (inclusief Git LFS) en de releases | ja | GitHub-token (fine-grained, alleen *Contents: read* op `woutr-nl/WOUTR-WP`) |
| `BRICKS_LICENSE_KEY` | Bricks-licentiesleutel, alleen doorgegeven bij het deployen van een Bricks-site | ja | tekst |
| `DASH_IMAGE_TAG` | Tag van de app-image die compose gebruikt, bijv. een commit-SHA om terug te rollen | nee, standaard `latest` | tekst (`latest` of een volledige commit-SHA) |
| `PORT` | Poort op de host waarop compose de app publiceert, alleen op `127.0.0.1` (in de container is het altijd 3000) | nee, standaard `3000` | getal |
| `PGHOST`, `PGPORT`, `PGUSER`, `PGDATABASE` | Alleen om de app buiten compose tegen een andere database te draaien | nee, standaard `db`, `5432`, `woutrdash`, `woutrdash` | tekst / getal |


### SSH-sleutel

Het dashboard heeft één eigen SSH-sleutel (Ed25519, zonder wachtwoordzin) waarmee de commando's op alle hostingaccounts inloggen. Bij de eerste start maakt het die sleutel zelf aan en bewaart hem versleuteld (met `ENCRYPTION_KEY`) in de database. De privésleutel is nergens te zien of te downloaden en wordt in log en resultaat vervangen door `[geheim]`.

De pagina **SSH-sleutel** (in de menubalk) toont de publieke sleutel (één regel, knop **Kopieer**), de vingerafdruk (`SHA256:…`), het type en wanneer hij is aangemaakt of overgenomen, plus hoe je hem op een hostingaccount zet: in DirectAdmin via *SSH Keys*, of als regel in `~/.ssh/authorized_keys`.

**Nieuwe sleutel genereren** (op die pagina, met bevestiging) vervangt de sleutel: de oude privésleutel wordt gewist en werkt direct niet meer, dus elke site mislukt tot de nieuwe publieke sleutel aan het hostingaccount is toegevoegd. Dat kan niet zolang er een run loopt. Runs daarna gebruiken meteen de nieuwe sleutel, zonder herstart. De vorige publieke sleutels en hun vingerafdrukken blijven onder *Vorige sleutels* staan.

**Upgrade vanaf een versie met `SSH_PRIVATE_KEY`**: staat er nog geen sleutel in de database en is `SSH_PRIVATE_KEY` ingesteld, dan neemt het dashboard die sleutel eenmalig over; bestaande sites blijven werken. Daarna wordt de variabele genegeerd (de sleutelpagina meldt het als hij nog is ingesteld) en kun je hem uit Rollout verwijderen. Plak de sleutel daarvoor zoals hij is, met alle regels; kan het veld geen meerdere regels bevatten, dan mag hij ook op één regel met `\n` tussen de regels (`awk '{printf "%s\\n", $0}' ~/.ssh/id_ed25519`).

**`ENCRYPTION_KEY` kwijt** betekent ook de SSH-sleutel kwijt: de app start dan niet meer met de bestaande database. Begin met een lege tabel `ssh_keys` (`docker compose exec db psql -U woutrdash -c 'DELETE FROM ssh_keys'`) zodat een nieuwe sleutel wordt gegenereerd, en zet de nieuwe publieke sleutel opnieuw op elk hostingaccount.

### DirectAdmin-resellerkoppeling

Optioneel. Zonder koppeling werkt alles zoals hierboven: de publieke sleutel zet je zelf op elk hostingaccount. Staan de sites als gebruikers onder een DirectAdmin-**reseller**account (DirectAdmin 1.55 of nieuwer), dan kan het dashboard dat zelf doen.

**Instellen** op de pagina **Instellingen** (in de menubalk):

- **Panel-URL**: het adres van het paneel, alleen `https://`, bijvoorbeeld `https://server.voorbeeld.nl:2222`.
- **Reseller-gebruikersnaam**: de DirectAdmin-gebruikersnaam van het reselleraccount (of een admin-account).
- **Wachtwoord of login key**: liever een DirectAdmin **login key** dan het resellerwachtwoord. Maak die in DirectAdmin onder *Login Keys* aan met alleen de opdrachten die nodig zijn: `CMD_API_SHOW_USERS`, `CMD_API_SHOW_USER_CONFIG`, `CMD_API_MODIFY_USER`, `CMD_SSH_KEYS`, `CMD_API_SHOW_DOMAINS` (domeinen van een account) en `CMD_API_DATABASES` (databases van een account tonen en aanmaken) en `CMD_API_SSL` (Let's Encrypt-certificaat aanvragen), met *login-as* toegestaan, en beperk hem bij voorkeur tot het IP-adres van het dashboard. Het geheim wordt versleuteld (met `ENCRYPTION_KEY`) opgeslagen en daarna nooit meer getoond, alleen vervangen; het komt niet in logs of runs.

**Verbinding testen** controleert dat het inloggen lukt en dat het account gebruikers kan beheren, en meldt anders waarom niet (inloggegevens geweigerd, paneel niet bereikbaar, geen reseller-account). **Koppeling verwijderen** zet het dashboard terug op handmatige installatie.

**Hosting-account per site**: kies op het siteformulier bij **Hosting-account (DirectAdmin-gebruiker)** het account waarop de site staat, uit de gebruikers van de reseller. *geen* mag; die site doet dan niet mee en SSH-doel, WordPress-pad en Site-URL blijven vrij in te vullen. Zonder resellerkoppeling is het veld vrije tekst.

**Domein en afgeleide velden**: na het kiezen van een account kies je een van zijn domeinen. Daarmee liggen SSH-doel (`<account>@<domein>`), WordPress-pad (`/home/<account>/domains/<domein>/public_html`) en Site-URL (`https://<domein>`) vast: ze worden ingevuld en zijn niet te bewerken, en de server berekent ze bij opslaan opnieuw. Bestaande sites met afwijkende waarden houden die tot je opnieuw kiest en opslaat; het formulier meldt welke waarden afwijken.

**Klant-slug en thematype**: de klant-slug kies je uit de mappen onder `clients/` op `main` van WOUTR-WP (via `GITHUB_TOKEN`). Het thematype volgt uit de `style.css` van die map (`Template: woutr` is Blokthema, `Template: bricks` is Bricks); een map zonder herkenbaar thematype is niet te kiezen. Laadt de lijst niet, dan meldt het formulier dat en kan een nieuwe site pas worden opgeslagen als de lijst weer laadt.

**Database**: met een hosting-account kies je *Nieuwe database aanmaken* (standaard voor een site zonder database) of een bestaande database van het account. Bij aanmaken maakt het dashboard na het opslaan een database en databasegebruiker `<account>_<klant-slug>` aan (met een volgnummer als die naam al bestaat; een bestaande database wordt nooit overschreven), met een gegenereerd sterk wachtwoord dat versleuteld wordt opgeslagen en alleen via **Toon** zichtbaar is. Mislukt het aanmaken, dan is de site toch opgeslagen en toont het bewerkformulier de reden; opnieuw opslaan probeert het opnieuw. Bij een bestaande database vul je zelf het wachtwoord in; DirectAdmin geeft dat niet terug.

**Bij opslaan** van een site met hosting-account zorgt het dashboard dat dat account SSH aan heeft (alleen als het pakket of de reseller dat toestaat) en dat de huidige publieke sleutel van het dashboard in de SSH-sleutels staat, één keer, met het label `woutr-dash`. Daarna draait automatisch de SSH-verbindingstest. Mislukt de installatie, dan is de site toch opgeslagen; het overzicht toont per site *geïnstalleerd* (met tijdstip en testresultaat), *mislukt* (met de reden), *geen hosting-account* of *geen resellerkoppeling*. Met **Opnieuw installeren** probeer je het opnieuw, bijvoorbeeld na het aanpassen van het pakket. Meerdere sites op één account krijgen de sleutel maar één keer.

**Bij een nieuwe sleutel** zet het dashboard de nieuwe sleutel op elk hostingaccount van een site en verwijdert het daar de vorige dashboardsleutel. Sleutels worden alleen verwijderd als ze exact gelijk zijn aan een eerdere dashboardsleutel; andere sleutels op het account blijven onaangeroerd. De pagina SSH-sleutel toont daarna onder *Installatie per site* het resultaat per site.

Een site verwijderen of het hosting-account wijzigen haalt de sleutel **niet** van het oude account; verwijder hem daar zo nodig zelf (label `woutr-dash`).

## CI en images

GitHub Actions (`.github/workflows/ci.yml`) bouwt en test de app; Rollout bouwt zelf niets meer, maar haalt de kant-en-klare image op.

- **Pull request naar `main`**: `npm ci`, `npm test` en een build van de image uit de `Dockerfile`. Er wordt niets gepubliceerd.
- **Push/merge naar `main`**: dezelfde tests en build, daarna wordt de image gepubliceerd als `ghcr.io/woutr-nl/woutr-wp-dash` met twee tags: `latest` en de volledige commit-SHA (40 tekens) van die commit.
- Falen de tests, dan faalt de run en wordt er niets gebouwd of gepubliceerd.
- De image is alleen voor `linux/amd64`. Publiceren gebeurt met het eigen `GITHUB_TOKEN` van de workflow; er is geen persoonlijk token of extra secret nodig. Alleen de publicatiejob (push naar `main`, na geslaagde tests) krijgt schrijfrecht op packages; tests en pull requests draaien met een token dat alleen kan lezen.
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
- **Inloggen op WordPress** (op de pagina Runs, zodra de site gedeployed is) laat `tools/login.sh` van WOUTR-WP via SSH een eenmalige inloglink voor de beheerder aanmaken en opent die in een nieuw tabblad, direct ingelogd in wp-admin. De link werkt één keer en verloopt na 5 minuten. Het dashboard slaat hem nergens op en logt hem niet; het staat ook niet in de geschiedenis.
- **Test SSH-verbinding** (op de pagina Runs) logt met de dashboardsleutel in op het SSH-doel van de site en verandert niets op de server. De uitkomst: verbinding geslaagd, sleutel niet geaccepteerd (zet de publieke sleutel op het hostingaccount), server niet bereikbaar (time-out of geweigerd), of hostsleutel veranderd. Voor hostsleutels gelden dezelfde regels als bij runs. De test staat niet in de geschiedenis en kan ook tijdens een run.
- **SSL aanvragen** (op de pagina Runs, voor een site met hosting-account en domein, zolang de resellerkoppeling is ingesteld) vraagt in DirectAdmin een gratis Let's Encrypt-certificaat aan voor `<domein>` en `www.<domein>`. Kan `www` niet worden gevalideerd (bijv. omdat het niet naar de server wijst), dan wordt alleen `<domein>` aangevraagd en zegt de uitkomst dat. Staat SSL uit voor het account, dan zet het dashboard het aan, en weer uit als de aanvraag mislukt. Staat er al een geldig certificaat, dan vraagt het dashboard eerst om bevestiging. Mislukt een **Live gaan**-run op `check_https`, dan staat de knop ook op die run; na een geslaagde aanvraag kun je daar opnieuw live gaan. De laatste uitkomst (tijd, namen, verloopdatum of de reden van mislukken) staat op de pagina Runs en in het siteoverzicht. Een aanvraag is geen run: hij telt niet mee voor de ene run per site en kan ook tijdens een run; per site loopt één aanvraag tegelijk. Verlengen doet DirectAdmin zelf.
- Elke run bewaart actie, keuzes, start- en eindtijd, uitkomst, exitcode, het `key=value`-resultaat en het volledige log.

**Geheimen** gaan alleen via omgevingsvariabelen naar de commando's (`WP_DB_PASS`, `WOUTR_SMTP_PASS`, `BRICKS_LICENSE_KEY`, `GH_TOKEN`), nooit als argument. De commando's krijgen geen andere variabelen van het dashboard mee. Alle geheimen (database-, SMTP- en Bricks-wachtwoord, SSH-sleutel, GitHub-token en het gegenereerde beheerderswachtwoord) worden in log en resultaat vervangen door `[geheim]`; het beheerderswachtwoord staat alleen versleuteld bij de site.

**SSH-hostsleutels**: bij de eerste verbinding met een server wordt diens hostsleutel vertrouwd en onthouden. Verandert die sleutel later, dan weigert SSH te verbinden en mislukt de run met een duidelijke melding. Klopt de nieuwe sleutel (bijv. na een serververhuizing), verwijder dan de oude regel van die host uit `/data/ssh/known_hosts` in de container: `docker compose exec app ssh-keygen -R <host> -f /data/ssh/known_hosts`.

## Gezondheidscontrole en meldingen

Elk uur controleert het dashboard elke gedeployde site over HTTP(S), zonder SSH en zonder iets op de site te veranderen: **Bereikbaar** (2xx/3xx binnen 10 seconden), **Certificaat** (geldig voor de host, waarschuwing binnen 14 dagen voor het verlopen) en, voor sites die ooit live zijn gegaan, **Indexering** (geen `noindex`). Het overzicht toont het laatste resultaat per site, de pagina Runs per controle, met de knop **Nu controleren**. De controle staat los van runs en komt niet in de geschiedenis.

**Meldingen** (link in de menubalk, met het aantal open meldingen) ontstaan bij een mislukte of onderbroken run en bij een controle die twee keer achter elkaar faalt; een certificaatwaarschuwing meteen. Een melding lost zichzelf op zodra de controle slaagt of een latere run van dezelfde actie slaagt. **Afvinken** kan ook met de hand; een afgevinkt gezondheidsprobleem komt pas terug nadat de controle eerst weer is geslaagd. Opgeloste en afgevinkte meldingen blijven 30 dagen zichtbaar. Er gaat niets buiten het dashboard (geen e-mail of chat).

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
export GITHUB_TOKEN=dummy BRICKS_LICENSE_KEY=dummy
docker compose up
```

Na een wijziging in de code: opnieuw `docker build …` en `docker compose up`. Open daarna <http://localhost:3000>. Het dashboard maakt bij de start zelf een SSH-sleutel aan. Met dummywaarden voor `GITHUB_TOKEN` en `BRICKS_LICENSE_KEY` werkt het beheer van sites, maar mislukken runs. `POSTGRES_PASSWORD` is hier bewust een vaste waarde: Postgres stelt het wachtwoord alleen in bij de eerste start van een leeg volume, dus een ander wachtwoord bij een volgende start geeft `password authentication failed` en een app die blijft herstarten. Wil je het wachtwoord wijzigen, wis dan eerst de lokale database met `docker compose down -v`. Bewaar ook `ENCRYPTION_KEY` als je dezelfde database opnieuw wilt gebruiken, anders zijn de opgeslagen wachtwoorden en de SSH-sleutel onleesbaar.

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
