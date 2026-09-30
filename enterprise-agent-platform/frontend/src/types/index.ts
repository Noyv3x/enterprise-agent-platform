export interface BrandingSnapshot {
  schema_version: 1;
  revision: number;
  product_name: string;
  agent_name: string;
  primary_color: string;
  logo_url: string | null;
}
