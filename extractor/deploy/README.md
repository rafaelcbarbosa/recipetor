# Extractor deployment (remote mode)

These units run the extractor job service on a stronger host (the home server at
`192.168.1.190` in this deployment). The Recipetor app calls it over the LAN.

## Direct connection (current setup)

1. Copy the extractor directory to the home server:

   ```sh
   tar -czf - --exclude='.venv' --exclude='__pycache__' extractor \
     | ssh nas 'rm -rf /home/coxinha/recipetor-extractor && mkdir -p /home/coxinha/recipetor-extractor && tar -xzf - -C /home/coxinha/recipetor-extractor --strip-components=1'
   ```

2. Set up the Python environment:

   ```sh
   ssh nas 'cd /home/coxinha/recipetor-extractor && bash setup.sh'
   ```

3. Copy `recipetor-extractor.env.example` to
   `~/.config/recipetor-extractor.env`, fill in `RECIPE_API_TOKEN` and
   `RECIPE_API_KEY`, and set `chmod 600`.

4. Allow the app host to reach the service, then install and start it:

   ```sh
   ssh nas 'sudo ufw allow from 192.168.1.200 to any port 8099 proto tcp'
   ssh nas 'sudo cp /home/coxinha/recipetor-extractor/deploy/recipe-extractor.service /etc/systemd/system/'
   ssh nas 'sudo systemctl daemon-reload && sudo systemctl enable --now recipe-extractor.service'
   ```

5. On the app host:

   ```sh
   RECIPE_EXTRACTOR_URL=http://192.168.1.190:8099
   RECIPE_EXTRACTOR_TOKEN=<same RECIPE_API_TOKEN>
   ```

6. Verify from the app host:

   ```sh
   curl -s http://192.168.1.190:8099/healthz
   ```

## Reverse tunnel (only if the app host cannot reach the extractor host)

Use `recipe-extractor-tunnel.service` on the extractor host and point the app at
`http://127.0.0.1:8099`. The tunnel binds the forwarded port to the app host's
loopback only.
