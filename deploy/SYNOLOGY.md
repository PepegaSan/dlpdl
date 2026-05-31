# Clip-Direct on Synology (Docker)

1. Copy or clone this repository onto the NAS.
2. In DSM **Container Manager** → **Project** → import `deploy/docker-compose.yml` (build context = repository root).
3. Create a downloads folder on the NAS, e.g. `/volume1/docker/clip-direct/downloads`.
4. Adjust the volume in `docker-compose.yml`:

   ```yaml
   volumes:
     - /volume1/docker/clip-direct/downloads:/downloads
   ```

5. Expose port **8090**. Extension server URL: `http://<NAS-IP>:8090/`

## ARM / amd64

On older ARM models you may need an explicit platform build:

```bash
docker buildx build --platform linux/amd64 -f deploy/Dockerfile -t clip-direct .
```

## Storage target

- **PC (default):** Extension setting “PC (browser download)” — file is saved via the web UI on your computer.
- **NAS:** Extension “NAS” + optional subfolder — files are written under `/downloads` in the container volume.
