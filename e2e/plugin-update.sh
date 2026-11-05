#!/bin/sh
# Eén echte update van de WOUTR-plugin, van eind tot eind: de Bricks-testsite van WOUTR-WP met de
# plugin vraagt het echte dashboard (deze app, in een container op het netwerk van de testsite) om
# de nieuwste versie, en de achtergrondupdater downloadt en installeert de zip van het dashboard.
# Alleen GitHub is nagemaakt (e2e/dashboard.js), met een release 99.0.0 die van plugin/ in WOUTR-WP
# wordt gebouwd. Op de site wijst WOUTR_UPDATE_URL naar het dashboard, en mag WordPress die
# downloadhost bereiken: in productie is het dashboard een publieke host, hier een privé-IP. De
# controle na de update laadt de site via http://wordpress, zoals tools/wp-test/plugin-update-e2e.sh.
#
#   ../WOUTR-WP/tools/wp-test/setup-bricks.sh
#   npm ci && e2e/plugin-update.sh            # WOUTR-WP elders: WOUTR_WP=<pad> e2e/plugin-update.sh
#
# Stopt met een fout bij de eerste regel die niet klopt en zet de site daarna terug.
set -eu
cd "$(dirname "$0")/.."
dash=$(pwd)
wpdir=$(cd "${WOUTR_WP:-../WOUTR-WP}" && pwd)
compose=$wpdir/tools/wp-test/docker-compose.yml
self=woutr-plugin/woutr-plugin.php
name=woutr-dash-e2e-$$
tmp=$(mktemp -d)

dc() { docker compose -f "$compose" "$@"; }
wp() { dc run --rm -T cli wp "$@" 2>/dev/null | tr -d '\r'; }
check() { # check <omschrijving> <commando…>
	what=$1
	shift
	if ! "$@"; then
		echo "FOUT: $what" >&2
		exit 1
	fi
	echo "ok  $what"
}
same() { [ "$1" = "$2" ] || { echo "verwacht '$2', kreeg '$1'" >&2; return 1; }; }
offered() { wp eval "\$t = get_site_transient( 'update_plugins' ); echo \$t->response['$self']->$1 ?? '';"; }
reset_checks() { wp eval "delete_site_transient( 'update_plugins' ); delete_transient( 'woutr_plugin_update_failed' );" >/dev/null; }

[ -d node_modules/@electric-sql/pglite ] || { echo 'Draai eerst npm ci.' >&2; exit 1; }
wp plugin is-active woutr-plugin >/dev/null || { echo "Draai eerst $wpdir/tools/wp-test/setup-bricks.sh." >&2; exit 1; }

cleanup() {
	docker rm -f "$name" >/dev/null 2>&1 || true
	dc exec -T wordpress sh -c '
		[ ! -f /tmp/wp-config.dash-e2e ] || mv /tmp/wp-config.dash-e2e wp-config.php
		rm -f wp-content/mu-plugins/zz-dash-e2e.php
		rm -rf wp-content/plugins/woutr-plugin && ln -sfn ../themes/woutr/plugin wp-content/plugins/woutr-plugin' || true
	wp plugin activate woutr-plugin >/dev/null || true
	reset_checks || true
	rm -rf "$tmp"
}
trap cleanup EXIT

# De release op de nep-GitHub: plugin/ uit WOUTR-WP als versie 99.0.0.
old=$(sed -n 's/^[[:space:]]*\*[[:space:]]*Version:[[:space:]]*//p' "$wpdir/plugin/woutr-plugin.php" | head -1)
cp -r "$wpdir/plugin" "$tmp/woutr-plugin"
sed 's/^\( \* Version: *\).*/\199.0.0/' "$wpdir/plugin/woutr-plugin.php" > "$tmp/woutr-plugin/woutr-plugin.php"
cp "$tmp/woutr-plugin/woutr-plugin.php" "$tmp/woutr-plugin.php"
(cd "$tmp" && zip -qr woutr-plugin.zip woutr-plugin)
chmod -R a+rX "$tmp"

# Het dashboard, bereikbaar als http://dash:8080 vanaf de site (WordPress downloadt alleen via
# poort 80, 443 of 8080).
network=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}' "$(dc ps -q wordpress)")
docker run -d --name "$name" --network "$network" --network-alias dash -e E2E_DIR=/e2e -e PORT=8080 \
	-v "$dash:/app:ro" -v "$tmp:/e2e:ro" -w /app node:24-alpine node e2e/dashboard.js >/dev/null
i=0
until docker logs "$name" 2>&1 | grep -q luistert; do
	i=$((i + 1))
	[ "$i" -lt 60 ] || { docker logs "$name" >&2; echo 'FOUT: het dashboard start niet' >&2; exit 1; }
	sleep 1
done
echo 'ok  het dashboard draait'

# De plugin als echte kopie: een update wist de oude map, ook dwars door de symlink naar WOUTR-WP.
dc exec -T wordpress sh -c 'rm -f wp-content/plugins/woutr-plugin &&
	cp -r wp-content/themes/woutr/plugin wp-content/plugins/woutr-plugin && chown -R www-data: wp-content/plugins/woutr-plugin
	cp wp-config.php /tmp/wp-config.dash-e2e &&
	sed -i "/^<?php/a define( \"WOUTR_UPDATE_URL\", \"http://dash:8080\" );" wp-config.php
	mkdir -p wp-content/mu-plugins && cat > wp-content/mu-plugins/zz-dash-e2e.php && chown www-data: wp-content/mu-plugins/zz-dash-e2e.php' <<'EOF'
<?php
add_filter( 'http_request_host_is_external', function ( $external, $host ) {
	return 'dash' === $host ? true : $external;
}, 10, 2 );
// WordPress's check after an update loads the site at home_url(), http://localhost:8080; inside the container that is http://wordpress.
add_filter( 'pre_http_request', function ( $pre, $args, $url ) {
	if ( false !== strpos( $url, 'wp_scrape_key' ) && 0 === strpos( $url, home_url() ) ) {
		return wp_remote_get( str_replace( home_url(), 'http://wordpress', $url ), $args );
	}
	return $pre;
}, 10, 3 );
add_filter( 'redirect_canonical', function ( $redirect ) {
	return isset( $_GET['wp_scrape_key'] ) ? false : $redirect;
} );
EOF
same "$(wp plugin get woutr-plugin --field=version)" "$old"
echo "ok  de site staat op $old"

echo '== De site vraagt het dashboard om updates'
reset_checks
wp eval 'wp_update_plugins();' >/dev/null
same "$(offered new_version)" 99.0.0
same "$(offered package)" http://dash:8080/woutr-plugin/woutr-plugin.zip
echo 'ok  WordPress biedt 99.0.0 aan, met de zip van het dashboard'
check 'het dashboard haalde de release bij GitHub, met het token' sh -c "docker logs '$name' | grep -q '\"github\":\"https://api.github.com/repos/woutr-nl/WOUTR-WP/releases?per_page=100\".*\"auth\":true'"
same "$(offered tested)" "$(sed -n 's/^[[:space:]]*\*[[:space:]]*Tested up to:[[:space:]]*//p' "$tmp/woutr-plugin.php" | head -1)"
echo 'ok  met "Tested up to" uit de release'

echo '== De achtergrondupdater installeert de zip van het dashboard'
wp eval 'add_filter( "wp_doing_cron", "__return_true" ); wp_maybe_auto_update();' >/dev/null
same "$(wp plugin get woutr-plugin --field=version)" 99.0.0
echo 'ok  geïnstalleerd: 99.0.0'
check 'blijft actief' wp plugin is-active woutr-plugin
check 'de geïnstalleerde bestanden zijn die uit de zip' sh -c "dc() { docker compose -f '$compose' \"\$@\"; }; dc exec -T wordpress cat wp-content/plugins/woutr-plugin/woutr-plugin.php | cmp -s - '$tmp/woutr-plugin.php'"
check 'de zip kwam bij GitHub vandaan, als octet-stream met het token' sh -c "docker logs '$name' | grep -q '\"github\":\"https://api.github.com/repos/woutr-nl/WOUTR-WP/releases/assets/1\",\"accept\":\"application/octet-stream\",\"auth\":true'"

echo 'Alles goed.'
