import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate, unauthenticated } from "../shopify.server";
import { getKlaviyoPropertyName } from "../lib/klaviyoPropertyMap";

type AdminLike = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

/** Normalized topic from @shopify/shopify-api (e.g. customers/update → CUSTOMERS_UPDATE). */
const CUSTOMERS_UPDATE_TOPIC = "CUSTOMERS_UPDATE";

const ALLOWED_NAMESPACES = new Set(["counterpoint", "klaviyo"]);

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

async function syncPropertyToKlaviyo(params: {
  shop: string;
  email: string;
  propertyName: string;
  rawValue: string | null | undefined;
}) {
  const { shop, email, propertyName, rawValue } = params;
  const apiKey = process.env.KLAVIYO_API_KEY;
  if (!apiKey) {
    console.error("[klaviyo-sync] KLAVIYO_API_KEY is not set");
    return;
  }

  const propertyValue =
    rawValue === null || rawValue === undefined ? "" : String(rawValue);

  const revision =
    process.env.KLAVIYO_API_REVISION?.trim() || "2024-10-15";

  const klaviyoBody = {
    data: {
      type: "profile",
      attributes: {
        email,
        properties: {
          [propertyName]: propertyValue,
        },
      },
    },
  };

  const klaviyoRes = await fetch("https://a.klaviyo.com/api/profiles/", {
    method: "POST",
    headers: {
      Authorization: `Klaviyo-API-Key ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      revision,
    },
    body: JSON.stringify(klaviyoBody),
  });

  if (!klaviyoRes.ok) {
    const text = await klaviyoRes.text();
    console.error(
      `[klaviyo-sync] Klaviyo API failed status=${klaviyoRes.status} shop=${shop} property="${propertyName}"`,
      text,
    );
  } else {
    console.log(
      `[klaviyo-sync] Synced Klaviyo property="${propertyName}" shop=${shop}`,
    );
  }
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
      console.warn(
        `[klaviyo-sync] No Admin API context (session=${session ? "present" : "missing"}) shop=${shop}`,
        error,
      );
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

  for (const mf of metafields) {
    const namespace = mf.namespace ?? "";
    const key = mf.key ?? "";

    if (!ALLOWED_NAMESPACES.has(namespace)) {
      continue;
    }

    const propertyName = getKlaviyoPropertyName(namespace, key);
    if (!propertyName) {
      console.log(
        `[klaviyo-sync] Ignoring customers/update: unmapped ${namespace}:${key} shop=${shop}`,
      );
      continue;
    }

    await syncPropertyToKlaviyo({
      shop,
      email,
      propertyName,
      rawValue: mf.value,
    });
  }

  return new Response();
};
