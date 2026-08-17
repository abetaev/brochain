import { expose } from "comlink";
import { createAccountService } from "./service.ts";

expose(createAccountService());
