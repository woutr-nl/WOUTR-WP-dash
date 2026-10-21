# WOUTR-WP-dash

Webdashboard voor het beheren van WOUTR-klantsites. Het houdt per site de gegevens bij die de `WOUTR-WP`-commando's (`tools/deploy.sh`, `tools/update.sh`, `tools/live.sh`) als invoer nodig hebben. Geheimen (database- en SMTP-wachtwoord) worden versleuteld opgeslagen (AES-256-GCM).

Fase 1 (deze versie): inloggen als beheerder en sites toevoegen, bewerken en verwijderen. Het uitvoeren van de commando's en de run-geschiedenis komen in fase 2.

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
| `SSH_PRIVATE_KEY` | SSH-sleutel waarmee de commando's inloggen op de hostingaccounts (fase 2) | ja | OpenSSH private key, zie hieronder |
| `GITHUB_TOKEN` | Token met leesrecht op de releases van `woutr-nl/WOUTR-WP` (fase 2) | ja | GitHub-token (fine-grained, alleen *Contents: read* op `woutr-nl/WOUTR-WP`) |
| `BRICKS_LICENSE_KEY` | Bricks-licentiesleutel voor Bricks-sites (fase 2) | ja | tekst |
| `PORT` | Poort op de host waarop compose de app publiceert (in de container is het altijd 3000) | nee, standaard `3000` | getal |
| `PGHOST`, `PGPORT`, `PGUSER`, `PGDATABASE` | Alleen om de app buiten compose tegen een andere database te draaien | nee, standaard `db`, `5432`, `woutrdash`, `woutrdash` | tekst / getal |

De drie variabelen voor fase 2 (`SSH_PRIVATE_KEY`, `GITHUB_TOKEN`, `BRICKS_LICENSE_KEY`) worden nu nog niet gebruikt, maar zijn al verplicht zodat een installatie meteen compleet is.

### SSH-sleutel invullen

Plak de volledige inhoud van het sleutelbestand (bijv. `~/.ssh/id_ed25519`) **zoals hij is, met alle regels**, in het waardeveld van `SSH_PRIVATE_KEY` in Rollout, inclusief de regels `-----BEGIN OPENSSH PRIVATE KEY-----` en `-----END OPENSSH PRIVATE KEY-----`. Voeg geen aanhalingstekens toe.

Kan een veld geen meerdere regels bevatten, dan mag de sleutel ook op één regel met `\n` tussen de regels:

```sh
awk '{printf "%s\\n", $0}' ~/.ssh/id_ed25519
```

Gebruik een aparte sleutel zonder wachtwoordzin voor het dashboard, waarvan de publieke sleutel op de hostingaccounts staat.

## Deployen op Rollout

1. Maak in Rollout een **docker compose**-app aan op deze repository; Rollout gebruikt `docker-compose.yml` zoals hij is.
2. Stel in de UI van Rollout **alle verplichte variabelen** uit de tabel hierboven in. Maak geen `.env`-bestand aan en zet nooit geheimen in de repository.
3. Laat Rollout het domein en HTTPS regelen en verkeer doorsturen naar de app-service op poort **3000** (gewoon HTTP). De app vertrouwt de proxy (één hop) voor het client-IP en HTTPS, zodat het login-cookie `Secure` is.
4. Deploy. De databasetabellen worden bij het starten automatisch aangemaakt.

De databasegegevens staan in het benoemde volume `dbdata`; ze blijven bewaard bij herstarten en opnieuw deployen. Verwijder dat volume niet.

## Lokaal draaien

Met Docker en compose; de variabelen worden geëxporteerd in de shell (geen `.env`):

```sh
export ADMIN_USER=admin
export ADMIN_PASSWORD='kies-een-wachtwoord'
export SESSION_SECRET="$(openssl rand -base64 32)"
export ENCRYPTION_KEY="$(openssl rand -base64 32)"
export POSTGRES_PASSWORD="$(openssl rand -base64 24)"
export SSH_PRIVATE_KEY=dummy GITHUB_TOKEN=dummy BRICKS_LICENSE_KEY=dummy
docker compose up --build
```

Open daarna <http://localhost:3000>. Voor fase 1 volstaan dummywaarden voor de drie fase-2-variabelen. Bewaar `ENCRYPTION_KEY` en `POSTGRES_PASSWORD` als je dezelfde database opnieuw wilt gebruiken; `docker compose down -v` wist de lokale database.

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
