# Extractor deployment (remote mode)

These units run the extractor job service and its reverse tunnel on a stronger
host (for example `discovery`). The Recipetor app on the low-RAM host calls the
service at `127.0.0.1:8099` through the tunnel.

1. Copy `recipetor-extractor.env.example` to
   `~/.config/recipetor-extractor.env`, fill in the token and API key, and set
   `chmod 600`.

2. Adjust the paths in `recipe-extractor.service` if the repo is not at
   `/mnt/projects/recipetor`, then install both units:

   ```sh
   sudo cp recipe-extractor.service recipe-extractor-tunnel.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now recipe-extractor.service recipe-extractor-tunnel.service
   ```

3. On the app host, set `RECIPE_EXTRACTOR_URL=http://127.0.0.1:8099` and
   `RECIPE_EXTRACTOR_TOKEN` to the same `RECIPE_API_TOKEN`.

4. Verify from the app host:

   ```sh
   curl -s http://127.0.0.1:8099/healthz
   ```
