# XUL widgets (button, radio, menuitem) render from their `label` attribute and
# keep their indicator or arrow in internal content. Localize them with an
# attribute — a plain value makes Fluent write textContent, wiping that content.

# Citation databases
pref-citation-databases = Citation Databases (shown in this order)
pref-database-instructions = Enter 1-3 databases separated by commas
pref-database-options-label = Options:
pref-database-field =
    .placeholder = crossref, semanticscholar
pref-validate-button =
    .label = Validate
pref-database-duplicate = Duplicate databases found
pref-database-invalid = Invalid database(s): { $databases }
pref-database-count = Please enter 1-3 databases
pref-database-valid = ✓ Valid database configuration

# Automatic updates
pref-fetch-on-add = Fetch tallies for new items
pref-fetch-on-add-enabled =
    .label = Fetch tallies when items are added
pref-fetch-on-add-disabled =
    .label = Don't fetch tallies for new items
pref-auto-update-settings = Automatic Updates
pref-auto-update-description = Automatically update citation tallies for items in your library
pref-auto-update-never =
    .label = Never update automatically
pref-auto-update-startup =
    .label = Update outdated citations on startup
pref-auto-update-cutoff-label = Consider citations outdated after:
pref-auto-update-cutoff-3 =
    .label = 3 months
pref-auto-update-cutoff-6 =
    .label = 6 months
pref-auto-update-cutoff-12 =
    .label = 12 months
pref-auto-update-cutoff-24 =
    .label = 24 months

# Display
pref-color-settings = Display Options
pref-color-description = Color tallies in column
pref-use-colors =
    .label = Use colors for different databases
pref-no-colors =
    .label = Display without colors

# API keys
pref-apikeys-heading = API keys
pref-apikey-intro = Optional, but recommended. Without a key, requests share Semantic Scholar's anonymous pool with every other client using it, so lookups are slower and less reliable.
pref-apikey-storage = Stored unencrypted in Zotero's preferences.
pref-apikey-label = Semantic Scholar
pref-apikey-field =
    .placeholder = s2k-***
pref-apikey-valid = ✓ API key is valid
pref-apikey-invalid = ✗ Semantic Scholar rejected this key
pref-apikey-indeterminate = Couldn't check the key just now. Try again.
pref-apikey-error = Semantic Scholar returned an unexpected error
pref-apikey-empty = No key set (using anonymous access)
pref-apikey-checking = Checking…
pref-apikey-unavailable = Semantic Scholar is unavailable here
pref-apikey-cleaned = Removed invisible characters from the pasted key ({ $characters }).

pref-help = { $name } [Build { $version } { $time }]
