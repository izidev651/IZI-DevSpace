/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// IZI DevSpace: replaces the file surfer generates (its URLs point at
// zen-browser.app). `surfer import` copies src/ after branding, so this wins.

// No welcome / what's-new web pages: IZI DevSpace has its own New Tab.
pref("startup.homepage_override_url", "");
pref("startup.homepage_welcome_url", "");
pref("startup.homepage_welcome_url.additional", "");

// Give the user x seconds to react before showing the big UI. default=192 hours
pref("app.update.promptWaitTime", 691200);
// The updater is not built (--disable-updater); these only feed links.
pref("app.update.url.manual", "https://github.com/izidev651/IZI-DevSpace/releases");
pref("app.update.url.details", "https://github.com/izidev651/IZI-DevSpace/releases");
pref("app.releaseNotesURL", "https://github.com/izidev651/IZI-DevSpace/releases");
pref("app.releaseNotesURL.aboutDialog", "https://github.com/izidev651/IZI-DevSpace/releases");
pref("app.releaseNotesURL.prompt", "https://github.com/izidev651/IZI-DevSpace/releases");

// Number of usages of the web console.
// If this is less than 5, then pasting code into the web console is disabled
pref("devtools.selfxss.count", 5);
