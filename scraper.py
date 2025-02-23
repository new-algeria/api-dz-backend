import os
import sys
import json
import time
import random
import paramiko
import logging
from argparse import ArgumentParser
from urllib.parse import urlparse
from pathlib import Path
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.wait import WebDriverWait
from selenium.webdriver import ActionChains
from selenium.webdriver.common.keys import Keys

# Configure logging (unchanged)
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('scraper.log'),
        logging.StreamHandler()
    ]
)
logging.info('Starting the scraper...')

class SFTPManager:
    def __init__(self, uri):
        parsed = urlparse(uri)
        self.host = parsed.hostname
        self.port = parsed.port or 22
        self.user = parsed.username
        self.pwd = parsed.password
        self.base_path = parsed.path  # Preserve leading slash

        self.transport = paramiko.Transport((self.host, self.port))
        self.transport.connect(username=self.user, password=self.pwd)
        self.sftp = paramiko.SFTPClient.from_transport(self.transport)

    def get_json(self, filename):
        """Secure JSON file download with validation"""
        # local_path = str(Path(filename).name)
        # remote_path = os.path.join(self.base_path, filename)
        local_path = Path(filename).name
        remote_path = Path(self.base_path) / filename

        try:
            self.sftp.get(str(remote_path), str(local_path))
            with open(local_path, 'r') as f:
                return json.load(f)
        except (FileNotFoundError, json.JSONDecodeError) as e:
            print(f"Error loading {filename}: {str(e)}")
            raise
        except Exception as e:
            self.sftp.close()
            self.transport.close()
            raise

    def put_json(self, data, filename):
        """Atomic file update with temp file"""
        temp_file = f"{filename}.tmp"
        with open(temp_file, 'w') as f:
            json.dump(data, f, indent=2)
        
        try:
            self.sftp.put(temp_file, str(self.base_path / filename))
            Path(temp_file).unlink()
        finally:
            if Path(temp_file).exists():
                Path(temp_file).unlink()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.sftp.close()
        self.transport.close()


def human_like_delay(min_t=1, max_t=3):
    time.sleep(random.uniform(min_t, max_t))

def human_type(element, text, delay=(0.1, 0.5)):
    """Simulate human typing with random delays between keystrokes"""
    ActionChains(element._parent).move_to_element(element).click().perform()
    for char in text:
        element.send_keys(char)
        time.sleep(random.uniform(*delay))

def solve_cloudflare(driver):
    try:
        if "cloudflare" in driver.page_source.lower():
            driver.switch_to.frame(driver.find_element(By.XPATH, "//iframe[contains(@title, 'Challenge')]"))
            verify_btn = WebDriverWait(driver, 15).until(
                EC.element_to_be_clickable((By.XPATH, "//span[@class='mark']"))
            )
            ActionChains(driver).move_to_element(verify_btn).pause(1).click().perform()
            driver.switch_to.default_content()
            human_like_delay(3, 5)
            return True
    except Exception:
        return False

def perform_login(driver, email, password):
    """Handle login flow with human-like interactions"""
    driver.get("https://rapidapi.com/studio")
    
    # Wait for login page to load
    WebDriverWait(driver, 10).until(
        EC.presence_of_element_located((By.ID, "login-form_email")))
    
    # Fill email
    email_field = driver.find_element(By.ID, "login-form_email")
    human_type(email_field, email)
    human_like_delay(1, 2)
    
    # Fill password
    password_field = driver.find_element(By.ID, "login-form_password")
    human_type(password_field, password)
    human_like_delay(1, 2)
    
    # Click submit
    submit_btn = WebDriverWait(driver, 10).until(
        EC.element_to_be_clickable((By.CSS_SELECTOR, "button[type='submit']")))
    ActionChains(driver).move_to_element(submit_btn).pause(1).click().perform()
    human_like_delay(2, 4)
    
    # Wait for login to complete
    WebDriverWait(driver, 20).until(
        EC.url_contains("studio"))
    human_like_delay(2, 4)  # Additional post-login delay

def process_object(driver, obj, jwt_token):
    """Enhanced processing with robust element handling"""
    for attempt in range(3):
        try:
            # Navigate to target page with extended wait
            driver.get("https://rapidapi.com/studio/api_22dd3f3e-f11a-494c-a080-228eb6f67e8c/client/4b16491c-11b6-468c-b841-03c78261b8cd")
            WebDriverWait(driver, 20).until(
                EC.presence_of_element_located((By.TAG_NAME, 'body'))
            )
            
            # --- Click 'Add' Button with JS-based detection ---
            try:
                human_like_delay(10, 15)
                
                # Inject JavaScript to search (including shadow DOM) and click the add button
                js_script = """
                console.log("Starting search for add button...");
                function findButtonInContext(context) {
                    const addSvg = context.querySelector('svg[aria-label="add"]');
                    if (addSvg) {
                        console.log("Found SVG with aria-label 'add'");
                        const addButton = addSvg.closest('button');
                        if (addButton) {
                            console.log("Found closest button for add SVG");
                            addButton.style.border = '3px solid #00ff00'; // Green border for success
                            return addButton;
                        }
                    }
                    
                    const tooltipButton = context.querySelector('button[aria-describedby^="tooltip-"]');
                    if (tooltipButton) {
                        console.log("Found tooltip button");
                        tooltipButton.style.border = '3px solid #ff0000'; // Red border for fallback
                        return tooltipButton;
                    }
                    console.log("No button found in current context");
                    return null;
                }

                function searchInShadowDOM(element) {
                    if (element.shadowRoot) {
                        console.log("Element has shadowRoot, searching within it");
                        const button = findButtonInContext(element.shadowRoot);
                        if (button) return button;
                        for (const child of element.shadowRoot.children) {
                            const result = searchInShadowDOM(child);
                            if (result) return result;
                        }
                    }
                    for (const child of element.children) {
                        const result = searchInShadowDOM(child);
                        if (result) return result;
                    }
                    return null;
                }

                //let button = findButtonInContext(document) || searchInShadowDOM(document.body);
                let button = false;
                
                if (!button) {
                    console.log("Button not found in document, now checking iframes");
                    const iframes = document.querySelectorAll('iframe');
                    for (const iframe of iframes) {
                        try {
                            const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
                            console.log("Searching in iframe:", iframe);
                            button = findButtonInContext(iframeDoc) || searchInShadowDOM(iframeDoc.body);
                            if (button) break;
                        } catch(e) {
                            console.log("Error accessing iframe:", e);
                        }
                    }
                }
                if (button) {
                    console.log("Button successfully found:", button);
                    // Add visual feedback
                    button.style.border = '3px solid #00ff00';
                    button.style.boxShadow = '0 0 10px rgba(0,255,0,0.5)';
                    button.click();
                    return button;
                }
                console.log("Add button not found after searching all contexts");
                return null;
                """
                # Execute JS and get element reference
                # element = driver.execute_script(js_script)
                # print(f"Element: {element}")
                # print(element)
                # if element:
                #     logging.info("Button found and visually confirmed - attempting click...")
                #     # Try 3 different click methods with verification
                #     success = False
                # driver.save_screenshot('2-button_visual_confirmation.png')
                # if element:
                #     logging.info("Button visually confirmed - attempting click...")
                    
                #     # Try 3 different click methods with verification
                #     success = False
                #     for attempt in range(3):
                #         try:
                #             # Method 1: Direct JavaScript click
                #             driver.execute_script("arguments[0].click();", element)
                #             human_like_delay(0.5, 1)
                            
                #             # Verify click by checking for expected result
                #             if driver.execute_script("return document.querySelector('.request-editor') !== null"):
                #                 success = True
                #                 break
                            
                #             # Method 2: Selenium click with scroll into view
                #             driver.execute_script("arguments[0].scrollIntoView({behavior: 'smooth', block: 'center'});", element)
                #             human_like_delay(0.3, 0.7)
                #             ActionChains(driver).move_to_element(element).pause(0.5).click().perform()
                            
                #             # Method 3: Click via coordinates as last resort
                #             if not success:
                #                 rect = element.rect
                #                 ActionChains(driver).move_by_offset(rect['x'], rect['y']).click().perform()
                            
                #             success = True
                #             break
                #         except Exception as e:
                #             logging.warning(f"Click attempt {attempt+1} failed: {str(e)}")
                #             human_like_delay(1, 2)
                    
                #     if not success:
                #         raise Exception("All click attempts failed")
                        
                #     logging.info("Add button successfully clicked with verification")
                # else:
                #     raise Exception("Add button not found in DOM")
                
                result = driver.execute_script(js_script)
                driver.save_screenshot('button_visual_confirmation.png')
                if result:
                    logging.info("Add button found and clicked via JS injection.")
                else:
                    raise Exception("Add button not found in injected JS script.")

            
            except Exception as e:
                logging.error(f"Add button error via JS injection: {str(e)}")
                driver.save_screenshot("error_add_button_js.png")
                raise

            # --- Handle Endpoint Input with visibility check ---
            try:
                endpoint_input = WebDriverWait(driver, 15).until(
                    EC.visibility_of_element_located(
                        (By.CSS_SELECTOR, "div.e10vnnfs0.css-1dxvcps[contenteditable='true']")
                    ))
                human_like_delay(1, 2)
                endpoint_input.click()
                for char in f'https://api.dz.com/api/{obj["slug"]}':
                    endpoint_input.send_keys(char)
                    time.sleep(random.uniform(0.1, 0.3))
                logging.info("Endpoint input filled successfully")
            except Exception as e:
                logging.error(f"Endpoint input error: {str(e)}")
                raise

            # ... further processing steps ...

            return True
        except Exception as e:
            logging.error(f"Scraper Error: {str(e)}")
            if attempt == 2:
                driver.save_screenshot(f"crash_{obj['slug']}.png")
                raise
            human_like_delay(5, 10)
            driver.refresh()

            # --- Description Button with case-insensitive search ---
            try:
                desc_button = WebDriverWait(driver, 15).until(
                    EC.element_to_be_clickable((By.XPATH,
                        "//button[.//div[contains(translate(text(), 'DESCRIPTION', 'description'), 'description')]]")))
                ActionChains(driver).move_to_element(desc_button).pause(0.5).click().perform()
                logging.info("Description button clicked")
            except Exception as e:
                logging.error(f"Description button error: {str(e)}")
                raise
            
                    # --- Description Section ---
            try:
                # Click Description Button
                desc_button = WebDriverWait(driver, 15).until(
                    EC.element_to_be_clickable((By.XPATH, 
                        '//button[.//div[contains(translate(text(), "DESCRIPTION", "description"), "description")]]'))
                )
                ActionChains(driver).move_to_element(desc_button).pause(0.5).click().perform()
                logging.info("Clicked 'Description' button successfully")
            except Exception as e:
                logging.error(f"Failed to click 'Description' button: {str(e)}")
                raise

            # Fill Title Input
            try:
                title_input = WebDriverWait(driver, 15).until(
                    EC.visibility_of_element_located((By.CLASS_NAME, 'css-d4v849'))
                )
                title_input.clear()
                human_type(title_input, obj['title']['en'])  # Simulate human typing
                logging.info("Title input filled successfully")
            except Exception as e:
                logging.error(f"Failed to fill title input: {str(e)}")
                raise

            # Fill Description Textarea
            try:
                description_area = WebDriverWait(driver, 15).until(
                    EC.visibility_of_element_located((By.CSS_SELECTOR, 'textarea.css-1ccau2i'))
                )
                description_area.clear()
                human_type(description_area, obj['description']['en'])  # Simulate human typing
                logging.info("Description textarea filled successfully")
            except Exception as e:
                logging.error(f"Failed to fill description textarea: {str(e)}")
                raise

            # --- Auth Section ---
            try:
                # Click Auth Button
                auth_button = WebDriverWait(driver, 15).until(
                    EC.element_to_be_clickable((By.XPATH, 
                        '//button[.//div[contains(translate(text(), "AUTH", "auth"), "auth")]]'))
                )
                ActionChains(driver).move_to_element(auth_button).pause(0.5).click().perform()
                logging.info("Clicked 'Auth' button successfully")
            except Exception as e:
                logging.error(f"Failed to click 'Auth' button: {str(e)}")
                raise

            # Click Bearer Button
            try:
                bearer_button = WebDriverWait(driver, 15).until(
                    EC.element_to_be_clickable((By.XPATH, 
                        '//button[.//div[contains(translate(text(), "BEARER", "bearer"), "bearer")]]'))
                )
                ActionChains(driver).move_to_element(bearer_button).pause(0.5).click().perform()
                logging.info("Clicked 'Bearer' button successfully")
            except Exception as e:
                logging.error(f"Failed to click 'Bearer' button: {str(e)}")
                raise

            # Fill Token Input
            try:
                token_input = WebDriverWait(driver, 15).until(
                    EC.visibility_of_element_located((By.CSS_SELECTOR, '.css-sf4iut .css-kpahiq p'))
                )
                driver.execute_script("arguments[0].innerText = ''", token_input)
                human_type(token_input, jwt_token)  # Simulate human typing
                logging.info("Token input filled successfully")
            except Exception as e:
                logging.error(f"Failed to fill token input: {str(e)}")
                raise

            # --- Sync Section ---
            try:
                sync_button = WebDriverWait(driver, 15).until(
                    EC.element_to_be_clickable((By.CLASS_NAME, 'css-1rxme48'))
                )
                ActionChains(driver).move_to_element(sync_button).pause(0.5).click().perform()
                logging.info("Clicked 'Sync' button successfully")
                
                # Wait for sync with dynamic check instead of static sleep
                WebDriverWait(driver, 10).until(
                    lambda d: "sync complete" in d.page_source.lower() or 
                            "success" in d.page_source.lower()
                )
                logging.info("Sync completed successfully")
            except Exception as e:
                logging.error(f"Failed to complete sync: {str(e)}")
                raise

            return True
        except Exception as e:
            logging.error(f"Scraper Error: {str(e)}")
            if attempt == 2: 
                driver.save_screenshot(f"crash_{obj['slug']}.png")
                raise
            human_like_delay(5, 10)
            driver.refresh()
def main():
    parser = ArgumentParser(description='Automated API Documentation Updater')
    parser.add_argument('--mail', required=True, help='Login email')
    parser.add_argument('--password', required=True, help='Login password')
    parser.add_argument('--sftp-uri', required=True, help='SFTP connection URI')
    parser.add_argument('--token', required=True, help='JWT token for API requests')
    args = parser.parse_args()

    try:
        with SFTPManager(args.sftp_uri) as sftp:
            # Load data files
            current_data = sftp.get_json('datas_description.json')
            
            try:
                backup_data = sftp.get_json('datas_description_backup.json')
            except FileNotFoundError:
                backup_data = []
                sftp.put_json(backup_data, 'datas_description_backup.json')

            # Find new entries
            new_entries = [entry for entry in current_data if entry not in backup_data]
            if not new_entries:
                return

            # Configure browser
            options = webdriver.ChromeOptions()
            # Realistic User-Agent (Example Chrome on Windows - ADJUST)
            user_agent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            options.add_argument(f'--user-agent={user_agent}')
            options.add_argument('--disable-blink-features=AutomationControlled') # Try to hide automation
            options.add_argument('--window-size=1920,1080')
            options.add_argument('--disable-dev-shm-usage')
            # options.add_argument('--headless=new') # Keep non-headless for debugging
            # options.add_argument('--start-maximized')
            # options.add_argument('--disable-gpu')
            # options.add_argument('--no-sandbox')
            
            with webdriver.Chrome(options=options) as driver:
                driver.execute_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")
                # Perform login instead of cookie injection
                perform_login(driver, args.mail, args.password)
                
                success = True
                for idx, entry in enumerate(new_entries, 1):
                    try:
                        logging.info(f"Processing {entry['slug']} ({idx}/{len(new_entries)})")
                        if not process_object(driver, entry, args.token):
                            success = False
                            break
                    except Exception as e:
                        logging.error(f"Failed processing {entry['slug']}: {str(e)}")
                        success = False
                        break

                if success:
                    updated_backup = backup_data + new_entries
                    sftp.put_json(updated_backup, 'datas_description_backup.json')
                    print("Successfully updated backup")
                else:
                    print("Aborting backup update due to failures")

    except Exception as e:
        print(f"Critical failure: {str(e)}")
        sys.exit(1)

if __name__ == '__main__':
    main()