/** Local cache/catalog routes stay public; commercial marketplace routes do not. */
import { defineEventHandler } from "h3";
import { resolveLocalRequester } from "../local-owner";
import { handleLocalRecipeRequest } from "./local-api";

export default defineEventHandler((event) =>
  handleLocalRecipeRequest(event.req as Request, resolveLocalRequester),
);
