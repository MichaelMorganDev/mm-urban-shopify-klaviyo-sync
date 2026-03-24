import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate, unauthenticated } from "../shopify.server";
import {
  getAllMappedShopifyMetafieldKeys,
  getKlaviyoPropertyName,
} from "../lib/klaviyoPropertyMap";

type AdminLike = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

/** Normalized topic from @shopify/shopify-api (e.g. customers/update → CUSTOMERS_UPDATE). */
const CUSTOMERS_UPDATE_TOPIC = "CUSTOMERS_UPDATE";

const ALLOWED_NAMESPACES = new Set(["counterpoint", "klaviyo"]);
const SILENT_UNMAPPED_KLAVIYO_KEYS = new Set([
  "Customer_Number",
  "CUST_NO",
  "First_Sale_Date_",
  "Last_Sale_Date",
  "Loyalty_Program_1",
  "Name",
  "Store_ID",
]);
const MAPPED_SHOPIFY_KEYS = getAllMappedShopifyMetafieldKeys();

type MetafieldInPayload = {
  namespace?: string;
  key?: string;
  value?: string | null;
  type?: string;
};

/**
 * Shopify often omits `metafields` on CUSTOMERS_UPDATE even when namespaces are configured.
 * Fall back to Admin API so updates still sync.
 */
async function fetchMetafieldsAndEmailFromAdmin(
  admin: AdminLike,
  ownerId: number,
): Promise<{ metafields: MetafieldInPayload[]; email: string | null }> {
  const customerId = `gid://shopify/Customer/${ownerId}`;
  const gqlResponse = await admin.graphql(
    `#graphql
    query CustomerMetafieldsForSync($customerId: ID!) {
      customer(id: $customerId) {
        id
        defaultEmailAddress {
          emailAddress
        }
        counterpoint: metafields(first: 50, namespace: "counterpoint") {
          edges {
            node {
              namespace
              key
              value
            }
          }
        }
        klaviyo: metafields(first: 50, namespace: "klaviyo") {
          edges {
            node {
              namespace
              key
              value
            }
          }
        }
      }
    }`,
    { variables: { customerId } },
  );

  const gqlJson = (await gqlResponse.json()) as {
    data?: {
      customer?: {
        defaultEmailAddress?: { emailAddress?: string | null } | null;
        counterpoint?: {
          edges?: Array<{ node?: MetafieldInPayload | null } | null>;
        };
        klaviyo?: {
          edges?: Array<{ node?: MetafieldInPayload | null } | null>;
        };
      } | null;
    };
    errors?: unknown;
  };

  if (gqlJson.errors) {
    console.error("[klaviyo-sync] Admin GraphQL errors (metafield fetch)", gqlJson.errors);
  }

  const c = gqlJson.data?.customer;
  if (!c) {
    return { metafields: [], email: null };
  }

  const email =
    c.defaultEmailAddress?.emailAddress?.trim() &&
    c.defaultEmailAddress.emailAddress.trim().length > 0
      ? c.defaultEmailAddress.emailAddress.trim()
      : null;

  const metafields: MetafieldInPayload[] = [];
  for (const conn of [c.counterpoint, c.klaviyo]) {
    for (const edge of conn?.edges ?? []) {
      const n = edge?.node;
      if (n?.namespace != null && n.key != null) {
        metafields.push({
          namespace: n.namespace,
          key: n.key,
          value: n.value ?? null,
        });
      }
    }
  }

  return { metafields, email };
}

type CustomerWebhookPayload = {
  id?: number;
  email?: string | null;
  metafields?: MetafieldInPayload[];
  /** Some payloads may nest the customer resource */
  customer?: {
    id?: number;
    email?: string | null;
    metafields?: MetafieldInPayload[];
  };
};

function unwrapCustomer(payload: CustomerWebhookPayload): {
  id?: number;
  email?: string | null;
  metafields?: MetafieldInPayload[];
} {
  if (payload.customer && typeof payload.customer === "object") {
    return payload.customer;
  }
  return payload;
}

function isMissingOfflineSessionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "SessionNotFoundError" ||
    error.message.includes("Could not find a session for shop")
  );
}

function klaviyoRevision(): string {
  return process.env.KLAVIYO_API_REVISION?.trim() || "2024-10-15";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Find an existing Klaviyo profile by email (updates only — no profile creation).
 * @see https://developers.klaviyo.com/en/reference/get_profiles
 */
async function findKlaviyoProfileIdByEmail(params: {
  apiKey: string;
  email: string;
}): Promise<string | null> {
  const { apiKey, email } = params;
  const escaped = email.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const filter = `equals(email,"${escaped}")`;
  const url = new URL("https://a.klaviyo.com/api/profiles/");
  url.searchParams.set("filter", filter);

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Authorization: `Klaviyo-API-Key ${apiKey}`,
      Accept: "application/json",
      revision: klaviyoRevision(),
    },
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(
      `[klaviyo-sync] Klaviyo profile lookup failed status=${res.status}`,
      text,
    );
    return null;
  }

  const json = (await res.json()) as {
    data?: Array<{ id?: string }>;
  };
  const id = json.data?.[0]?.id;
  return id ?? null;
}

async function patchKlaviyoProfileProperties(params: {
  shop: string;
  profileId: string;
  setProperties: Record<string, string>;
  unsetProperties: string[];
  apiKey: string;
}): Promise<boolean> {
  const { shop, profileId, setProperties, unsetProperties, apiKey } = params;
  if (Object.keys(setProperties).length === 0 && unsetProperties.length === 0) {
    return true;
  }

  const body: Record<string, unknown> = {
    data: {
      type: "profile",
      id: profileId,
      attributes:
        Object.keys(setProperties).length > 0
          ? {
              properties: setProperties,
            }
          : {},
      ...(unsetProperties.length > 0
        ? {
            meta: {
              patch_properties: {
                unset: unsetProperties,
              },
            },
          }
        : {}),
    },
  };

  for (let attempt = 1; attempt <= 3; attempt++) {
    const klaviyoRes = await fetch(
      `https://a.klaviyo.com/api/profiles/${encodeURIComponent(profileId)}/`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Klaviyo-API-Key ${apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          revision: klaviyoRevision(),
        },
        body: JSON.stringify(body),
      },
    );

    if (klaviyoRes.ok) {
      console.log(
        `[klaviyo-sync] Patched Klaviyo profile shop=${shop} set=${Object.keys(setProperties).length} unset=${unsetProperties.length}`,
      );
      return true;
    }

    const text = await klaviyoRes.text();
    if (klaviyoRes.status === 429 && attempt < 3) {
      const retryAfterHeader = klaviyoRes.headers.get("retry-after");
      const retryAfterMs = Number(retryAfterHeader);
      const waitMs =
        Number.isFinite(retryAfterMs) && retryAfterMs > 0
          ? retryAfterMs * 1000
          : attempt * 1000;
      console.warn(
        `[klaviyo-sync] Klaviyo throttled (attempt ${attempt}/3), retrying in ${waitMs}ms shop=${shop}`,
      );
      await sleep(waitMs);
      continue;
    }

    console.error(
      `[klaviyo-sync] Klaviyo PATCH failed status=${klaviyoRes.status} shop=${shop} set=${Object.keys(setProperties).length} unset=${unsetProperties.length}`,
      text,
    );
    return false;
  }

  return false;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload, admin, session } =
    await authenticate.webhook(request);

  if (topic !== CUSTOMERS_UPDATE_TOPIC) {
    return new Response();
  }

  console.log(`[klaviyo-sync] CUSTOMERS_UPDATE received shop=${shop}`);

  const customer = unwrapCustomer(payload as CustomerWebhookPayload);
  let metafields: MetafieldInPayload[] = [...(customer.metafields ?? [])];

  let email =
    typeof customer.email === "string" ? customer.email.trim() || null : null;

  const ownerId = customer.id;
  if (ownerId === undefined || ownerId === null) {
    console.warn(`[klaviyo-sync] CUSTOMERS_UPDATE missing customer id shop=${shop}`);
    return new Response();
  }

  let adminApi: AdminLike | undefined = admin ?? undefined;
  if (!adminApi) {
    try {
      const ctx = await unauthenticated.admin(shop);
      adminApi = ctx.admin;
    } catch (error) {
      if (isMissingOfflineSessionError(error)) {
        console.warn(
          `[klaviyo-sync] No offline session for shop=${shop} (needed when webhooks omit metafields). ` +
            `Use a persistent DATABASE_URL (e.g. Render Postgres), run prisma migrate deploy on deploy, ` +
            `then open the app once in Admin to store the offline access token.`,
        );
      } else {
        console.warn(
          `[klaviyo-sync] No Admin API context (session=${session ? "present" : "missing"}) shop=${shop}`,
          error,
        );
      }
    }
  }

  if (metafields.length === 0) {
    if (!adminApi) {
      console.warn(
        `[klaviyo-sync] Webhook had no inline metafields and no offline session for ${shop}. Open the app in Admin once so the store has a session, then try again.`,
      );
      return new Response();
    }
    console.log(
      `[klaviyo-sync] Webhook had no inline metafields; loading counterpoint/klaviyo via Admin API customerId=${ownerId}`,
    );
    const fetched = await fetchMetafieldsAndEmailFromAdmin(adminApi, ownerId);
    metafields = fetched.metafields;
    if (!email && fetched.email) {
      email = fetched.email;
    }
  }

  if (metafields.length === 0) {
    console.log(
      `[klaviyo-sync] No counterpoint/klaviyo metafields on customer ${ownerId} shop=${shop}`,
    );
    return new Response();
  }

  if (!email && adminApi) {
    const customerId = `gid://shopify/Customer/${ownerId}`;
    const gqlResponse = await adminApi.graphql(
      `#graphql
      query GetCustomerIdentity($customerId: ID!) {
        customer(id: $customerId) {
          id
          defaultEmailAddress {
            emailAddress
          }
        }
      }`,
      { variables: { customerId } },
    );

    const gqlJson = (await gqlResponse.json()) as {
      data?: {
        customer?: {
          id?: string;
          defaultEmailAddress?: { emailAddress?: string | null } | null;
        } | null;
      };
      errors?: unknown;
    };

    if (gqlJson.errors) {
      console.error("[klaviyo-sync] Admin GraphQL errors", gqlJson.errors);
    }

    email =
      gqlJson.data?.customer?.defaultEmailAddress?.emailAddress?.trim() ||
      null;
  }

  if (!email) {
    console.log(
      `[klaviyo-sync] No Shopify customer email; skip Klaviyo shop=${shop} customerId=${ownerId}`,
    );
    return new Response();
  }

  const apiKey = process.env.KLAVIYO_API_KEY;
  if (!apiKey) {
    console.error("[klaviyo-sync] KLAVIYO_API_KEY is not set");
    return new Response();
  }

  const profileId = await findKlaviyoProfileIdByEmail({ apiKey, email });
  if (!profileId) {
    console.log(
      `[klaviyo-sync] No existing Klaviyo profile for email; skipping (updates only, no profile creation) shop=${shop}`,
    );
    return new Response();
  }

  const setProperties: Record<string, string> = {};
  const unsetProperties: string[] = [];
  const seenMappedKeys = new Set<string>();

  for (const mf of metafields) {
    const namespace = mf.namespace ?? "";
    const key = mf.key ?? "";

    if (!ALLOWED_NAMESPACES.has(namespace)) {
      continue;
    }

    const propertyName = getKlaviyoPropertyName(namespace, key);
    if (!propertyName) {
      if (
        namespace === "klaviyo" &&
        SILENT_UNMAPPED_KLAVIYO_KEYS.has(key)
      ) {
        continue;
      }
      console.log(
        `[klaviyo-sync] Ignoring customers/update: unmapped ${namespace}:${key} shop=${shop}`,
      );
      continue;
    }
    seenMappedKeys.add(`${namespace}:${key}`);

    const raw = mf.value === null || mf.value === undefined ? "" : String(mf.value);
    if (raw.trim().length === 0) {
      unsetProperties.push(propertyName);
    } else {
      setProperties[propertyName] = raw;
    }
  }

  for (const mappedKey of MAPPED_SHOPIFY_KEYS) {
    if (seenMappedKeys.has(mappedKey)) {
      continue;
    }
    const [namespace, key] = mappedKey.split(":");
    if (!namespace || !key) {
      continue;
    }
    if (!ALLOWED_NAMESPACES.has(namespace)) {
      continue;
    }
    const propertyName = getKlaviyoPropertyName(namespace, key);
    if (!propertyName) {
      continue;
    }
    if (setProperties[propertyName] !== undefined) {
      continue;
    }
    unsetProperties.push(propertyName);
  }

  await patchKlaviyoProfileProperties({
    shop,
    profileId,
    setProperties,
    unsetProperties,
    apiKey,
  });

  return new Response();
};
