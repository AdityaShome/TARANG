# THREDDS Data Server v5.9 for TARANG
# ─────────────────────────────────────────────────────────────────────────────
# Base image: unidata/thredds-docker:5.9
# Requires: Java 17, Jakarta EE 9+, Tomcat 10
# ─────────────────────────────────────────────────────────────────────────────

FROM unidata/thredds-docker:5.9

LABEL maintainer="TARANG Team — SIH 2026 PS 26067"
LABEL description="THREDDS Data Server for TARANG ocean visualization platform"

# ── Expose port ──────────────────────────────────────────────────────────────
EXPOSE 8080

# ── JVM tuning for demo (adjust Xmx based on available host RAM) ─────────────
ENV JAVA_OPTS="-Xmx2g -Xms512m -XX:+UseG1GC -Djava.security.egd=file:/dev/./urandom"

# ── Copy catalog and server config ───────────────────────────────────────────
# NOTE: unidata/thredds-docker expects these at:
#   /usr/local/tomcat/content/thredds/catalog.xml
#   /usr/local/tomcat/content/thredds/threddsConfig.xml
# These are also volume-mounted in docker-compose.yml for live editing.
COPY catalog.xml       /usr/local/tomcat/content/thredds/catalog.xml
COPY threddsConfig.xml /usr/local/tomcat/content/thredds/threddsConfig.xml

# ── Data directory is volume-mounted at runtime ───────────────────────────────
# ./data/netcdf → /usr/local/tomcat/content/thredds/public/netcdf
# (see docker-compose.yml volumes section)
