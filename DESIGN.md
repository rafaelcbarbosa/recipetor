# Recipetor Design Spec

Phone-first (iPhone 390 x 844 baseline), Apple design language. This file supersedes the previous DESIGN.md. Do not invent new styles; where this file is silent, ask. Values below are exact.

## 1. Tokens

### Colors

| Token | Value | Use |
|---|---|---|
| ink | `#29251f` | Primary text, icons, fat bar |
| muted | `#6b635a` | Secondary text (darkened from `#827a70` for contrast) |
| canvas | `#faf8f4` | Page background |
| surface | `#ffffff` | Cards, groups, pills |
| hairline | `#ece7df` | Separators, bar tracks |
| tomato | `#e56b45` | Icons, stars, hearts, progress, carbs bar (graphics only, not small text) |
| tomato-action | `#b94a2b` | Filled primary buttons, link-style text, active tab text (passes 4.5:1 with white) |
| herb | `#63816a` | Ready/positive icon, protein bar |
| butter | `#f5e6bf` | Warm blocks, tag chips, image placeholders, step numbers |
| tint-active | `rgba(229,107,69,.16)` | Active tab background |
| field | `rgba(41,37,31,.07)` | Search field background |

Hover/pressed for `tomato-action`: a slightly darker shade (suggested `#9f3f24`; not yet in the design).

### Effects

- Glass (floating bars, round buttons): `background: rgba(255,255,255,.78); backdrop-filter: blur(20px)` (also `-webkit-backdrop-filter`); `box-shadow: 0 1px 3px rgba(41,37,31,.08), 0 4px 16px rgba(41,37,31,.06)`. Fallback when blur is unsupported: solid white.
- Pill shadow: `0 1px 2px rgba(41,37,31,.06)`.
- No borders on cards. Separation comes from white surfaces on the canvas plus hairline dividers inside groups.

### Typography

System font only (SF on Apple devices):
`-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif` with font smoothing antialiased.

| Role | Size / weight |
|---|---|
| Recipe title (detail) | 26 / 700, letter-spacing -0.02em, line-height 1.2 |
| Section heading | 20 / 600 |
| Top bar title, app name, row title, primary buttons | 17 / 600 (primary button 700) |
| Subtitle in lists | 15 / 400, muted |
| Meta, rating, helper text, group headers | 14 (group headers 600), muted unless noted |
| Tag chip | 13 (library row) or 14 (detail) |
| Tab label | 12 |
| Big kcal number | 24 / 700 |

No large (34 px) page titles. Each screen is titled by its top bar or a visual block (see screens).

### Spacing, shape, targets

- Page gutter 16. Vertical gap between blocks: 12 (library, queue), 20 (recipe detail).
- Radii: groups/cards/hero blocks 20; recipe thumbnails 16; detail hero image 18; app icon 9 (32 px); buttons and pills are capsules (radius = half height); floating tab bar 32; library tag chip 10; detail tag chip 16.
- Minimum touch target 44 x 44, including icon buttons, stars, steppers and the heart.
- Safe areas: use `env(safe-area-inset-top/bottom)` and `viewport-fit=cover`.

### Icons

24 px viewBox, stroke 1.8, round caps and joins, no fill, except the favorited heart and filled stars (fill `tomato`). Lucide equivalents are fine: chevron-left, chevron-right, chevrons-up-down, search, user, heart, star, share, clock, list, circle-check, circle-alert, loader, circle-plus, book-open, soup. Decorative icons get `aria-hidden="true"`; icon-only buttons get `aria-label`.

App icon: 32 px rounded square, `tomato` fill, white bowl-with-steam glyph (20 px).

## 2. Screens

### 2.1 Library (home)

Top to bottom, 16 px side padding:

1. **Top bar:** app icon + "Recipetor" (h1, 17/600) on the left. On the right, a **backlog icon button** (round glass, 44, `list` icon) immediately left of the account round glass button (44), 8 px gap. When jobs are active the backlog button shows a `tomato-action` count badge (min 18 px, radius 9, white 11/700) at its top-right; counts above 9 show `9+`. Tap opens Queue.
2. **Search:** height 44, capsule, `field` background, no border, 17 px text, search icon left, placeholder "Search recipes or ingredients", visible `<label>` hidden off-screen.
3. **Filter pills:** three equal-width capsule buttons, height 44, white, 15/500: **Meal**, **Cuisine**, **Diet**, each with a chevrons-up-down icon (14 px, muted). Each opens a pull-down menu. Filters combine (AND).
   - Meal options: Breakfast, Lunch, Dinner, Dessert, Snacks.
   - Cuisine options: built from the cuisines present in the library (Italian, French, Mediterranean, American, ...).
   - Diet options: Vegan, Vegetarian, Gluten-free, Low-carb, plus other restrictions.
4. **Recipe list:** one white group (radius 20, overflow hidden). Each row: padding 12, gap 12.
   - Thumbnail 72 x 72, radius 16 (`butter` placeholder; `object-fit: cover` image when available).
   - Title 17/600 (right padding 36 to clear the heart), subtitle "Cuisine · Meal · N min" (15, muted).
   - Rating line: filled star (14 px) + average (bold) + "(count)" (muted) + one diet tag chip.
   - Heart button top-right of the row (44 x 44): outline = not favorited, filled `tomato` = favorited. Hairline dividers start at x = 96 (after the thumbnail).
5. **Floating tab bar:** absolute, left/right 16, bottom 20, height 64, radius 32, glass, padding 6, gap 4. Tabs: **Recipes**, **Add**, **Favorites** (icon 24 + label 12). Tab height 52, radius 26. Active tab: `tint-active` background, `tomato-action` text, weight 600. The list scrolls under the bar: give the scroll area at least 100 px bottom padding.

### 2.2 Recipe detail

Pushed screen (no tab bar). 16 px padding, 20 px gaps.

1. **Top bar:** back (round glass 44) on the left; favorite heart and share (round glass 44) on the right.
2. **Hero image:** height 180, radius 18, `butter` placeholder with a centered icon until a real image exists.
3. **Title block:** title (26/700) and meta "30 min · 4 servings · ★ 4.6 (128 ratings)" (14, muted).
4. **Tags row:** wrapping row, gap 8. First chip is the meal type (dark: `ink` background, white text); then cuisine, diet and custom tags (`butter`, height 32, radius 16, 14 px); last a dashed "+ Add tag" button (height 44, 1.5 px dashed `muted` border, radius 22).
5. **Your rating:** label "Your rating" (15) on the left; five star buttons (44 x 44 each, star 26 px, outline `tomato`, filled when selected) on the right.
6. **Source row** (button, white, radius 20, height 52): "Found in N Instagram posts" + chevron. Opens the list of source links.
7. **Nutrition card** (white, radius 20, padding 16): "Per portion" (20/600) with the kcal total on the right (24/700). Three rows with grid `76px 1fr 88px`, gap 12, top margin 12: label, 8 px bar on a `hairline` track, "17 g · 13%". Bar colors: protein `herb`, carbs `tomato`, fat `ink`. The percentage is the share of calories.
8. **Ingredients:** heading (20/600) on the left and a **servings stepper** on the right: capsule (white, radius 22) with a minus button (44), "N servings" (15/700, min-width 64, centered) and a plus button (44). Helper text below: "Amounts update with the number of servings." Rows: min-height 52, hairline bottom separator; columns amount (bold, width 84) | name (flex) | kcal (14, muted).
   - Rule: each amount and each ingredient kcal scales by `selected_servings / base_servings`. Per-portion nutrition does not change. Minimum 1 serving.
   - Amount cell: a 44 px button when the unit is convertible (weight/volume) or when the amount/unit is missing. It opens the unit sheet or the amount/unit sheet. Plain amounts (count units such as clove) are not editable. Missing calories show "—".
   - Unit sheet: compatible units only — weight g, kg, mg, oz, lb; volume ml, l, tsp, tbsp, cup, fl oz, pint, quart, gallon. Selecting a unit converts the amount and preserves the physical quantity and calories. Incompatible conversions are rejected.
   - Amount/unit sheet: for ingredients without a quantity or unit. Fields: amount and unit (including "No unit"). Saving persists the value to the recipe.
   - Missing calories: when a recipe is saved, the server reuses calories/macros from another recipe with the same normalized ingredient name and a compatible unit, using a per-gram/per-ml/per-piece rate. Equivalent names (plurals, preparation words, name containment) are matched. Existing values are never overwritten.
9. **Steps:** heading (20/600); each step has a 28 px `butter` circle with the number (14/700) and text 16/1.45.
10. **Primary button** pinned at the bottom: "Start cooking", full width, height 56, radius 28, `tomato-action` background, white 17/700.

**Owner actions:** the "Delete recipe" link appears only for the recipe's creator or the site admin.

Scrolling: this screen is taller than the viewport; the content scrolls normally.

### 2.3 Queue

Pushed screen from the top-bar backlog icon. 16 px padding, 12 px gaps, 34 px bottom padding.

1. **Top bar:** back (round glass 44), centered title "Queue" (17/600), a 44 px spacer on the right.
2. **Summary block:** `butter`, radius 20, height 88, padding 0 20: a 52 px white circle with a list icon (`tomato`, 28 px) and the text "N recipes in the queue" (17/600) over "Processed one at a time, in order." (14, muted). The count covers active jobs only.
3. **Your recipe:** group header (14/600, muted, left margin 16), then a white card (radius 20, padding 16) for the active job where the user is the creator **or a watcher**:
   - Shortened URL (17/600) and a position badge "#P" (`tomato-action` background, white 15/700, radius 14, padding 3 12).
   - Status line (15, muted): the live extractor step plus percentage, e.g. "Transcribing audio (faster-whisper: medium) · 43%". Pending jobs show "Waiting for your turn · 0%".
   - 4-step progress: four bars (height 4, radius 2, gap 4) and labels (14): Queued, Fetching, Extracting, Saving. Completed and current bars `tomato`, others `hairline`; the current label is `ink` 600.
4. **All recipes in the queue:** group header, then a white group. Only active jobs are shown. Row min-height 60, padding 0 16, gap 12, hairline separator starting at x = 52:
   - Leading status icon (24): running = arc spinner in `tomato`; waiting = clock in `muted`.
   - Shortened URL (17/600); for the creator and watchers add a "You" chip (13/600, `butter`, radius 10).
   - Subtitle (14, muted): the live step label + " · position N", or "Waiting · position N".
   - Show no names or user data, only shortened links.
5. **Couldn't be extracted:** group header, then a white group containing failures from the last 24 hours, one row per link:
   - Failed row: `tomato` exclamation icon (24), shortened URL (17/600), "Couldn't read this post" (14, muted), "You" chip for the creator/watchers, and a trailing **Enter manually** text button (height 44, 15/600, `tomato-action`) for the creator/watchers.
   - Completed jobs are never shown in the queue. Their recipes live in the Library; a "Recipe ready: <title>" toast announces completion.
   - Once a link has a recipe (manual entry or a successful retry), its failure row disappears immediately.
6. **Data refresh:** poll every 2 seconds. Failed jobs are hidden after 24 hours.

### 2.4 Manual recipe entry (sheet)

Opened from **Enter manually** on a failed row. Bottom sheet (radius 20, padding 20, scrollable):

1. Title "Add recipe manually" + close (44).
2. Hint: "The link will be attached, so future submissions open this recipe."
3. Fields: Title (required, 150), Category (select: Breakfast, Lunch, Dinner, Dessert, Snack, Other), Cuisine (optional, 50), Servings (1-1000), Prep minutes (1-1440), Description (optional, 500).
4. Ingredients: repeatable cards. Top row: amount (56), unit select (76; known units), name (flex), remove (44). Second row: optional kcal. "Add ingredient" text button (44).
5. Steps: textarea, one step per line.
6. Primary "Save recipe" (56), secondary "Cancel".
7. Saving: creates the recipe, attaches the failed link as a source, links the failed job to it, favorites + histories the entrant and every watcher, closes the sheet, opens the recipe, and removes the failure row.

### 2.5 Add recipe

Top bar is the same as the Library (app icon, backlog icon, account). 16 px padding, 12 px gaps.

1. Heading "Add a recipe" (20/600).
2. White card (radius 20, padding 16): explanation "Paste a public Instagram post or reel link. We'll turn it into a recipe you can cook."
3. Import form: link field (height 44, capsule, `field` background, placeholder "Paste link") + primary **Add to backlog** button (44, `tomato-action`, white 15/700). The button is disabled only while the request is submitted.
4. Latest job progress: 4 px `tomato` bar on a `hairline` track, live step label on the left and percentage on the right. Helper text: "Recipes are processed one at a time. You can add another link while the backlog runs."
5. Extractor status line: dot + "Recipe extractor connected" / "not available" / "server unavailable".
6. Outcomes:
   - Valid new link: opens **Queue**.
   - Already-processed link: opens the recipe; signed-in users get it favorited + added to history; signed-out users just get the recipe.
   - Recently failed link: dialog (see below).
   - Currently queued link: joins the existing job as a watcher and opens Queue.

**Already-failed dialog:** title "Link already tried", body "This link was tried before but it was not possible to extract the recipe.", primary **Try again**, secondary **Cancel**. Signed-out users see **Sign in to try again** instead; signing in and retrying registers them as a watcher first. Try again queues a new job; Cancel clears the input and shows "Request cancelled."

### 2.6 Favorites (signed out)

When the Favorites tab is opened while signed out, the search/filter/list is replaced by a white gate card (radius 20, padding 32 20, centered):

- 64 px `butter` circle with a filled `tomato` heart (28).
- "Sign in to see your favorites" (20/600).
- "Your favorites and history sync across devices." (15, muted).
- **Sign in** primary and **Create account** secondary buttons, full width.

When signed in, Favorites uses the normal Library search/filters/list filtered to favorites.

### 2.7 Telemetry (admin-only page)

A separate web page at `/telemetry` — not part of the phone app, not linked from it, and marked `noindex`. It signs in with the **admin Recipetor account** (same email/password); non-admin sessions are rejected.

Sections: app/extractor status, uptime, version; recipe totals, by category, by cuisine, latest added; users total/active 7d/30d and top users; latest accesses and most-viewed recipes; completed/failed extractions with average/min/max time and recent jobs; favorites and ratings; queue depth and 24h failures; database size and event retention.

Usage events are retained **90 days**. Signed-out activity is anonymous; signed-in activity stores the user so the admin can see top users and latest accesses.

### 2.8 Import, queue & favorites rules

- **Dedupe:** never create a second job for a link that is already queued. Join it as a watcher instead, with the same queue rights as the original poster.
- **Watchers:** `isMine` is true for the creator and every watcher. Watchers see the job in **Your recipe**, get the "You" chip, receive the recipe as a favorite + history entry on completion, and can retry or enter a recipe manually.
- **Completed jobs:** never shown in the queue. The new recipe is inserted into the Library without a refresh and a toast announces completion.
- **Failures:** visible for 24 hours, deduplicated by link, then hidden. A failure row disappears immediately once its link has a recipe.
- **Already failed link:** show the dialog; no duplicate job until the user chooses Try again.
- **Auto-favorite:** a signed-in user's imported, joined, manual, or already-saved recipe is favorited immediately. Signed-out imports are saved to the shared library without a favorite.
- **Deletion:** the site admin may delete any recipe; the original loader may delete their own. Legacy recipes with no loader can only be deleted by the admin.
- **Refresh:** queue polling every 2 seconds; the Library list updates when background jobs complete.

## 3. Data these screens need

- **Recipe:** id, title, image_url (nullable), cuisine, meal_types[], diet_tags[], custom_tags[], prep_time_minutes, base_servings, ingredients[{name, amount, unit, kcal}], steps[], nutrition_per_portion {kcal, protein_g, carbs_g, fat_g}, rating_avg, rating_count, source_posts[], can_delete.
- **Ingredient editing:** each line accepts a unit change among compatible units (weight/volume) and a persisted amount/unit when either is missing. Missing calories are inferred from other recipes at save time.
- **Per user:** is_favorite, my_rating (1 to 5 or none).
- **Queue job:** id, url, status (pending, processing, completed, failed), stage, stage_label (live extractor step), progress, position, is_mine (creator or watcher), can_retry, recipe_id, error, started_at, updated_at.
- **Watchers:** job_id, user_id. The creator is always a watcher; watchers receive the same queue rights and completion favorite/history as the creator.
- **Usage events:** id, user_id (nullable for signed-out activity), event (`app_open`, `recipe_view`, `favorite`, `rating`, `import`, `manual_entry`), recipe_id, created_at. Retained 90 days.
- **Telemetry:** aggregates over events, jobs, recipes, users, favorites and ratings. Admin-only; includes emails for signed-in activity.

## 4. Not designed yet

Sign in / create account screens; open and active states of the three filter menus; empty states (no recipes, empty queue, no search results); error states; dark mode; foldable and desktop layouts. The admin telemetry page is functional rather than part of the phone design system.

## 5. Decisions

- Custom tags: still open. Currently session-local; not shared or persisted per user.
- Ratings: resolved — shared average plus the signed-in user's own 1-5 rating.
- Favorites: resolved — a per-user flag on the shared recipe, not a copied recipe.
- Recipe deletion: resolved — the admin can delete any recipe; the original loader can delete their own.
- Queue watchers: resolved — watchers are treated the same as the original poster.

## 6. Accessibility

- Body text contrast is at least 4.5:1 (`muted` on canvas, white and `butter`); do not use `tomato` (`#e56b45`) for small text.
- Use real `<button>`, `<a>`, `<input>` + `<label>`; never click handlers on `div` or `span`.
- Keep the 44 x 44 minimum target on every interactive element.
- Do not rely on color alone (macro bars also show grams and percentages).
