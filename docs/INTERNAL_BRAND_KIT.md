# Internal brand-kit route

This public repository contains the **gate only**. Do not put kit content, imagery, staff identifiers, a private bundle URL, or production settings in Git, `public/`, Vite imports, a build artifact, or a public CDN. A draft pull request is not private.

The route is off by default. To activate it intentionally on the separate Admin service (see [ADMIN_HOST.md](./ADMIN_HOST.md)):

1. Use the service's existing `DEVBOARDS_SURFACE=admin`, production database, and working Better Auth configuration.
2. Mount a private, read-only directory outside the app and static-serving trees. Set `BEEZILLA_INTERNAL_BRAND_KIT_DIR` to that absolute directory **at runtime** on the Admin service only. Do not build it into the image.
3. Put the private `index.html` at the mount root and the private images/stylesheet under `assets/`. Use same-origin URLs of the form `/internal/brand-kit/assets/example.png`. Filenames accept lowercase ASCII letters, digits, hyphens and underscores, and `.png`, `.jpg`, `.jpeg`, `.webp`, or `.css`. No scripts, SVG files, remote resources, or symlinks. HTML and CSS are limited to 512 KiB each; each image to 24 MiB.
4. Sign in on the Admin service and open `/internal/brand-kit`. Access requires a verified Better Auth session and the existing database `admin` role assigned to that user's account ID. Default roles, environment email role fallback, normal users, disabled users, agent tokens and local auth bypasses cannot unlock it.

The page and every direct asset URL apply the same gate, even for HEAD requests. A disabled/misconfigured service, denied account or missing file receives a generic no-store 404. Removing the mount setting or revoking the session/database role disables access without a public redeploy. Local Vite dev does not expose the route; use the built Node service for deployment validation.

Run the self-contained policy and filesystem checks (no secrets, no real kit content) with `node --experimental-strip-types --test scripts/test-internal-brand-kit.mjs`. Before provisioning a real kit, also validate the matched Nitro build in the Admin environment: signed out and ordinary accounts cannot retrieve the page or direct images, while an authorized administrator can.
