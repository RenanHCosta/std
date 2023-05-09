import {
  filtersFromSearchParams,
  toFilter,
  toProduct,
} from "deco-sites/std/packs/vtex/utils/transform.ts";
import { paths } from "deco-sites/std/packs/vtex/utils/paths.ts";
import {
  getSegment,
  setSegment,
  withSegmentCookie,
} from "deco-sites/std/packs/vtex/utils/segment.ts";
import type {
  FacetSearchResult,
  PageType,
  ProductSearchResult,
  SelectedFacet,
} from "deco-sites/std/packs/vtex/types.ts";
import {
  withDefaultFacets,
  withDefaultParams,
} from "deco-sites/std/packs/vtex/utils/intelligentSearch.ts";
import { fetchAPI } from "deco-sites/std/utils/fetch.ts";
import { slugify } from "deco-sites/std/packs/vtex/utils/slugify.ts";
import {
  pageTypesFromPathname,
  pageTypesToBreadcrumbList,
} from "deco-sites/std/packs/vtex/utils/legacy.ts";
import type {
  Filter,
  ProductListingPage,
} from "deco-sites/std/commerce/types.ts";
import type { Fuzzy, Sort } from "deco-sites/std/packs/vtex/types.ts";
import type { Context } from "deco-sites/std/packs/vtex/accounts/vtex.ts";

/** this type is more friendly user to fuzzy type that is 0, 1 or auto. */
export type LabelledFuzzy = "automatic" | "disabled" | "enabled";

const sortOptions = [
  { value: "", label: "relevance:desc" },
  { value: "price:desc", label: "price:desc" },
  { value: "price:asc", label: "price:asc" },
  { value: "orders:desc", label: "orders:desc" },
  { value: "name:desc", label: "name:desc" },
  { value: "name:asc", label: "name:asc" },
  { value: "release:desc", label: "release:desc" },
  { value: "discount:desc", label: "discount:desc" },
];

const mapLabelledFuzzyToFuzzy = (
  labelledFuzzy?: LabelledFuzzy,
): Fuzzy | undefined => {
  switch (labelledFuzzy) {
    case "automatic":
      return "auto";
    case "disabled":
      return "0";
    case "enabled":
      return "1";
    default:
      return;
  }
};

export interface Props {
  /**
   * @description overides the query term
   */
  query?: string;
  /**
   * @title Items per page
   * @description number of products per page to display
   */
  count: number;

  /**
   * @title Sorting
   */
  sort?: Sort;

  /**
   * @title Fuzzy
   */
  fuzzy?: LabelledFuzzy;

  /**
   * @title Selected Facets
   * @description Override selected facets from url
   */
  selectedFacets?: SelectedFacet[];

  /**
   * @title Hide Unavailable Items
   * @description Do not return out of stock items
   */
  hideUnavailableItems?: boolean;
}

export const singleFlightKey = (
  props: Props,
  { request }: { request: Request },
) => {
  const url = new URL(request.url);
  const { query, count, sort, page, selectedFacets, fuzzy } = searchArgsOf(
    props,
    url,
  );
  return `${query}${count}${sort}${page}${fuzzy}${
    selectedFacets.map((f) => `${f.key}${f.value}`).sort().join("")
  }`;
};

const searchArgsOf = (props: Props, url: URL) => {
  const hideUnavailableItems = props.hideUnavailableItems;
  const count = props.count ?? 12;
  const query = props.query ?? url.searchParams.get("q") ?? "";
  const page = Number(url.searchParams.get("page")) || 0;
  const sort = url.searchParams.get("sort") as Sort ?? "" as Sort;
  const selectedFacets = props.selectedFacets ||
    filtersFromSearchParams(url.searchParams);
  const fuzzy = mapLabelledFuzzyToFuzzy(props.fuzzy) ??
    url.searchParams.get("fuzzy") as Fuzzy;

  return {
    query,
    fuzzy,
    page,
    sort,
    count,
    hideUnavailableItems,
    selectedFacets,
  };
};

const PAGE_TYPE_TO_MAP_PARAM = {
  Brand: "brand",
  Collection: "productClusterIds",
  Cluster: "productClusterIds",
  Search: null,
  Product: null,
  NotFound: null,
  FullText: null,
};

const pageTypeToMapParam = (type: PageType["pageType"], index: number) => {
  if (type === "Category" || type === "Department" || type === "SubCategory") {
    return `category-${index + 1}`;
  }

  return PAGE_TYPE_TO_MAP_PARAM[type];
};

const filtersFromPathname = (pages: PageType[]) =>
  pages
    .map((page, index) => {
      const key = pageTypeToMapParam(page.pageType, index);

      if (!key || !page.name) {
        return;
      }

      return key && page.name && {
        key,
        value: slugify(page.name),
      };
    })
    .filter((facet): facet is { key: string; value: string } => Boolean(facet));

/**
 * @title VTEX product listing page - Intelligent Search
 * @description Returns data ready for search pages like category,brand pages
 */
const loader = async (
  props: Props,
  req: Request,
  ctx: Context,
): Promise<ProductListingPage | null> => {
  const { url: baseUrl } = req;
  const { configVTEX: config } = ctx;
  const url = new URL(baseUrl);
  const vtex = paths(config!);
  const segment = getSegment(req);
  const search = vtex.api.io._v.api["intelligent-search"];

  const {
    selectedFacets: baseSelectedFacets,
    page,
    ...args
  } = searchArgsOf(props, url);

  const pageTypesPromise = pageTypesFromPathname(url.pathname, ctx);
  const selectedFacets = baseSelectedFacets.length === 0
    ? filtersFromPathname(await pageTypesPromise)
    : baseSelectedFacets;

  const selected = withDefaultFacets(selectedFacets, ctx);
  const params = withDefaultParams({ ...args, page }, ctx);

  // search products on VTEX. Feel free to change any of these parameters
  const [productsResult, facetsResult] = await Promise.all([
    fetchAPI<ProductSearchResult>(
      `${search.product_search.facets(selected)}?${params}`,
      { withProxyCache: true, headers: withSegmentCookie(segment) },
    ),
    fetchAPI<FacetSearchResult>(
      `${search.facets.facets(selected)}?${params}`,
      { withProxyCache: true, headers: withSegmentCookie(segment) },
    ),
  ]);
  const { products: vtexProducts, pagination, recordsFiltered } =
    productsResult;
  const { facets } = facetsResult;

  // Transform VTEX product format into schema.org's compatible format
  // If a property is missing from the final `products` array you can add
  // it in here
  const products = vtexProducts.map((p) =>
    toProduct(p, p.items[0], 0, {
      baseUrl: baseUrl,
      priceCurrency: config!.defaultPriceCurrency,
    })
  );
  const filters = facets
    .map((f) => !f.hidden && toFilter(f, selectedFacets))
    .filter((x): x is Filter => Boolean(x));
  const itemListElement = pageTypesToBreadcrumbList(
    await pageTypesPromise,
    baseUrl,
  );

  const hasNextPage = Boolean(pagination.next.proxyUrl);
  const hasPreviousPage = page > 0;
  const nextPage = new URLSearchParams(url.searchParams);
  const previousPage = new URLSearchParams(url.searchParams);

  if (hasNextPage) {
    nextPage.set("page", (page + 1).toString());
  }

  if (hasPreviousPage) {
    previousPage.set("page", (page - 1).toString());
  }

  setSegment(segment, ctx.response.headers);

  return {
    "@type": "ProductListingPage",
    breadcrumb: {
      "@type": "BreadcrumbList",
      itemListElement,
      numberOfItems: itemListElement.length,
    },
    filters,
    products,
    pageInfo: {
      nextPage: hasNextPage ? `?${nextPage}` : undefined,
      previousPage: hasPreviousPage ? `?${previousPage}` : undefined,
      currentPage: page,
      records: recordsFiltered,
      recordPerPage: pagination.perPage,
    },
    sortOptions,
  };
};

export default loader;
