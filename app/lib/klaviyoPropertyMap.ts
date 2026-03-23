/**
 * Maps Shopify customer metafields (namespace:key) to exact Klaviyo custom property names.
 * Only keys listed here are synced; unknown pairs are ignored.
 */
const SHOPIFY_METAFIELD_TO_KLAVIYO_PROPERTY: Record<string, string> = {
  "counterpoint:LOY_1": "Loyalty Program 1",
  "counterpoint:LOY_2": "Loyalty Program 2",
  "counterpoint:LOY_3": "Loyalty Program 3",
  "counterpoint:CustomerCateg": "Customer Category",
  "counterpoint:CustomerNumber": "Customer Number",
  "counterpoint:Email": "Email",
  "counterpoint:FirstSaleDate": "First Sale Date ",
  "counterpoint:LastSaleDate": "Last Sale Date",
  "counterpoint:Name": "Name",
  "counterpoint:PhoneNumber": "Phone Number",
  "counterpoint:StoreID": "Store ID",
  "klaviyo:First_Sale_Date": "First Sale Date",
  "klaviyo:Date_of_Birth": "Date of Birth",
};

export function getKlaviyoPropertyName(
  namespace: string,
  key: string,
): string | undefined {
  return SHOPIFY_METAFIELD_TO_KLAVIYO_PROPERTY[`${namespace}:${key}`];
}
