---
name: PWA project rules
alwaysApply: true
---

- Stack: Vite + TypeScript. Keep it plain web tech so Capacitor can wrap it later.
- Design: follow the colors, fonts and spacing in DESIGN.md. Do not invent new styles.
- Mobile-first. Test layouts for iPhone 16/17 and Google Pixel phone screen sizes.
- Before large refactors, tell me what files you will change.
- Keep answers short. Show only the changed code.
- As the human to install whatever you need if you can´t install it yourself on this computer.
- the app should be always pushed to GITHUB. there is a job on the server that pulls updates every 1 min.

The App
- this is an app to store recipes
- the differencial from the other products is 1) the user will pass the recipe found via instagram and the tool will make it text like for future execution. 2) there are multiple accounts/instagrams with the same recipe, the app will consolidate these to make it easy for the user and avoid duplicates; 3) free
- is pwa allows, the app should integrate with the OS to allow sharing the link on an easier manner. if not possible, just skip this.
- the app must allow authentication using multiple ways: email, phone#, oauth for Google, Apple, Instragram?, see what makes sense.
- **Implemented: email/password authentication (login + create account) with JWT sessions. No email confirmation required for MVP. Users can sign up, sign in, and save recipes to their private library. Recipes are associated with the authenticated user.**
- **Implemented: Instagram recipe extraction via local AI (Hermes). Paste an Instagram post/reel URL → server extracts recipe text, ingredients, instructions. Duplicate detection consolidates multiple posts of the same recipe.**
- **Implemented: Nutritional analysis per ingredient (calories, protein, carbs, fat) with per-portion totals and macro percentages displayed in recipe modal.**
- **Implemented: Granular progress feedback during extraction — "Checking the link…" then "Extracting recipe with Hermes…". Fixed JSON parse errors on failed responses.**
- **Implemented: PWA with offline caching (service worker), installable manifest, mobile-first responsive design per DESIGN.md tokens.**
- **Implemented: Auto-deploy pipeline — push to GitHub → home lab server (192.168.1.200) pulls via cron every 1 min → accessible at recipetor.barbtech.com via Cloudflare Tunnel.**
- I don´t want data from the user. no need to track their information. lets have telemetry so we can better understand the app usage.
- when the user pass the instagram recipe, this link should go to the server. if the server alreeady found the recipe on previous sessions, the server will return it to the user. if the server never received this recipe/link, it will call a local api that will pass the link to a Local AI model/agent and it return the recipe to the app so it can be added to the db. If the recipe is duplicated, save the link on the right recipe and return that to the user. 
- The app will run on my 192.168.1.200 server on my home lab.
- The app should be accesible through my barbtech.com site that should redirect it to my server at home
